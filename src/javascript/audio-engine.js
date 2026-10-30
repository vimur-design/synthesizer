import * as Tone from 'tone'
import { CHORDS, midiToNote } from './model.js'
import { createDefaultForest, generateForest } from './forest-model.js'
import { nearestBranch, renderForest } from './forest-audio.js'
import forestWorkletUrl from './forest-worklet.js?worker&url'

const TICKS_PER_BEAT = 8
const TICKS_PER_BAR = 32
const TRACKS = ['piano', 'tree']
const TAIL_SECONDS = 4
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const number = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback

function compileProject(project) {
  const bars = clamp(Math.round(number(project.bars, 4)), 1, 16)
  const totalTicks = bars * TICKS_PER_BAR
  const result = {
    bpm: clamp(number(project.bpm, 72), 30, 200),
    bars,
    totalTicks,
    volume: clamp(number(project.volume, 0.65), 0, 1),
    loop: Boolean(project.loop),
    metronome: Boolean(project.metronome),
    forest: project.forest ?? createDefaultForest(),
    chords: Array.from(
      { length: bars },
      (_, index) => project.chords?.[index] ?? 'rest'
    ),
    tracks: {},
    events: new Map()
  }
  for (const track of TRACKS) {
    const source = project.tracks?.[track] ?? {}
    const notes = (source.notes ?? [])
      .filter((note) => Number.isFinite(Number(note.midi)))
      .map((note) => ({
        ...note,
        midi: clamp(Math.round(number(note.midi, 60)), 21, 108),
        start: clamp(Math.round(number(note.start, 0)), 0, totalTicks - 1),
        duration: clamp(Math.round(number(note.duration, 4)), 1, totalTicks),
        velocity: clamp(number(note.velocity, 0.65), 0, 1),
        track
      }))
    result.tracks[track] = { muted: Boolean(source.muted), notes }
    for (const note of notes) {
      if (!result.events.has(note.start)) result.events.set(note.start, [])
      result.events.get(note.start).push(note)
    }
  }
  return result
}

const workletModules = new WeakMap()

class ForestBank {
  constructor(context, destination, forest, offline = false) {
    this.context = context
    this.output = new Tone.Gain({ context, gain: 1 }).connect(destination)
    this.offline = offline
    this.node = null
    this.token = 0
    this.stats = { branchCount: 0, rms: 0, peak: 0, rainCount: 0 }
    this.onBranch = null
    this.ambient = false
    this.muted = false
    this.configure(forest)
  }

  async ready() {
    if (this.offline) return
    if (!workletModules.has(this.context)) {
      workletModules.set(
        this.context,
        this.context.rawContext.audioWorklet
          .addModule(forestWorkletUrl)
          .catch((error) => {
            workletModules.delete(this.context)
            throw error
          })
      )
    }
    await workletModules.get(this.context)
    this.node = this.context.createAudioWorkletNode('forest-resonators', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: this.data
    })
    Tone.connect(this.node, this.output)
    this.node.port.onmessage = ({ data }) => {
      if (data.type === 'stats') this.stats = data
      else if (data.type === 'branch') this.onBranch?.(data)
    }
    this.node.onprocessorerror = () => {
      this.stats = { ...this.stats, error: 'Ошибка AudioWorklet' }
    }
  }

  configure(forest) {
    this.data = { branches: generateForest(forest).branches, params: forest }
    this.branches = this.data.branches.filter((branch) => branch.gain > 0)
    this.stats.branchCount = this.branches.length
    this.node?.port.postMessage({ type: 'configure', forest: this.data })
  }

  send(event) {
    this.node?.port.postMessage(event)
  }

  strikeBranch(branchId, time, velocity = 0.8, source = 'branch') {
    const branch = this.branches.find((item) => item.id === branchId)
    if (!branch || this.muted) return null
    const token = ++this.token
    this.send({ type: 'strike', branchId, time, velocity, token, source })
    return {
      branchId,
      token,
      midi: Math.round(69 + 12 * Math.log2(branch.frequency / 440)),
      frequency: branch.frequency
    }
  }

  attack(midi, time, velocity = 0.65, source = 'sequence') {
    const branch = nearestBranch(this.branches, midi)
    return branch ? this.strikeBranch(branch.id, time, velocity, source) : null
  }

  release(voice, time) {
    if (voice)
      this.send({
        type: 'damp',
        branchId: voice.branchId,
        token: voice.token,
        time
      })
  }

  releaseAll(time) {
    this.ambient = false
    this.send({ type: 'releaseAll', time })
  }

  setAmbient(enabled, time) {
    if (this.ambient === enabled) return
    this.ambient = enabled
    this.send({ type: 'ambient', enabled, time })
    if (!enabled) this.send({ type: 'releaseAll', time })
  }

  setMuted(muted, time) {
    if (this.muted === muted) return
    this.muted = muted
    this.output.gain.rampTo(muted ? 0 : 1, 0.015, time)
    if (muted) this.releaseAll(time)
  }

  prepareOffline(project, duration, cycles) {
    const events = []
    const tickSeconds = 60 / project.bpm / TICKS_PER_BEAT
    if (!project.tracks.tree.muted) {
      events.push({ type: 'ambient', time: 0, enabled: true })
      let token = 0
      for (let cycle = 0; cycle < cycles; cycle += 1)
        for (const note of project.tracks.tree.notes) {
          if (note.velocity <= 0) continue
          const branch = nearestBranch(this.branches, note.midi)
          if (!branch) continue
          const time = (cycle * project.totalTicks + note.start) * tickSeconds
          token += 1
          events.push({
            type: 'strike',
            time,
            branchId: branch.id,
            velocity: note.velocity,
            token,
            source: 'sequence'
          })
          events.push({
            type: 'damp',
            time: time + note.duration * tickSeconds,
            branchId: branch.id,
            token
          })
        }
    }
    events.push({
      type: 'releaseAll',
      time: project.totalTicks * cycles * tickSeconds
    })
    const rendered = renderForest({
      sampleRate: this.context.sampleRate,
      duration,
      ...this.data,
      events
    })
    const buffer = this.context.rawContext.createBuffer(
      2,
      rendered.left.length,
      this.context.sampleRate
    )
    buffer.copyToChannel(rendered.left, 0)
    buffer.copyToChannel(rendered.right, 1)
    this.source = this.context.rawContext.createBufferSource()
    this.source.buffer = buffer
    Tone.connect(this.source, this.output)
    this.source.start(0)
    this.stats = {
      ...this.stats,
      rainCount: rendered.rainCount,
      strikeCount: rendered.strikeCount
    }
  }

  dispose() {
    if (this.node) {
      this.node.port.postMessage({ type: 'dispose' })
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node.port.close()
    }
    if (this.source) {
      try {
        this.source.stop()
      } catch {
      }
      this.source.disconnect()
    }
    this.output.dispose()
  }
}

function pianoVoiceOptions() {
  return {
    harmonicity: 1.001,
    modulationIndex: 1.15,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.006, decay: 1.5, sustain: 0.16, release: 0.65 },
    modulationEnvelope: {
      attack: 0.002,
      decay: 0.5,
      sustain: 0.015,
      release: 0.15
    }
  }
}

function piano(context) {
  return new Tone.PolySynth({
    context,
    voice: Tone.FMSynth,
    maxPolyphony: 16,
    volume: -14,
    options: pianoVoiceOptions()
  })
}

class SequencePiano {
  constructor(context, destination) {
    this.context = context
    this.destination = destination
    this.voices = []
    this.serial = 0
  }

  attack(midi, time, velocity) {
    let slot = this.voices.find((voice) => voice.freeAt <= time)
    if (!slot && this.voices.length < 16) {
      slot = {
        synth: new Tone.FMSynth({
          context: this.context,
          volume: -14,
          ...pianoVoiceOptions()
        }).connect(this.destination),
        freeAt: 0,
        generation: 0,
        order: 0
      }
      this.voices.push(slot)
    }
    if (!slot) {
      slot = [...this.voices].sort((left, right) => left.order - right.order)[0]
      slot.synth.triggerRelease(time)
    }
    slot.generation += 1
    slot.order = ++this.serial
    slot.freeAt = Infinity
    slot.synth.triggerAttack(midiToNote(midi), time, velocity)
    return { slot, generation: slot.generation }
  }

  release(token, time) {
    if (!token || token.slot.generation !== token.generation) return
    token.slot.synth.triggerRelease(time)
    token.slot.freeAt = time + 0.68
  }

  releaseAll(time) {
    for (const slot of this.voices) {
      slot.synth.triggerRelease(time)
      slot.generation += 1
      slot.freeAt = time + 0.68
    }
  }

  dispose() {
    for (const slot of this.voices) slot.synth.dispose()
    this.voices.length = 0
  }
}

function createVoiceChannel(context, destination, pan) {
  const filter = new Tone.Filter({
    context,
    type: 'lowpass',
    frequency: 5400,
    rolloff: -12
  })
  const delay = new Tone.FeedbackDelay({
    context,
    delayTime: 0.29,
    feedback: 0.16,
    wet: 0.12
  })
  const panner = new Tone.Panner({ context, pan, channelCount: 2 })
  filter.chain(delay, panner, destination)
  return {
    input: filter,
    dispose() {
      filter.dispose()
      delay.dispose()
      panner.dispose()
    }
  }
}

async function createSoundGraph(context, volume, forest) {
  const output = new Tone.Gain({ context, gain: volume })
  const limiter = new Tone.Limiter({ context, threshold: -2 })
  const meter = new Tone.Meter({ context, normalRange: true, smoothing: 0.7 })
  output.chain(limiter, meter, context.destination)
  const pianoChannel = createVoiceChannel(context, output, -0.35)
  const treeChannel = createVoiceChannel(context, output, 0.35)
  const sequencePiano = new SequencePiano(context, pianoChannel.input)
  const livePiano = piano(context).connect(pianoChannel.input)
  const previewPiano = piano(context).connect(pianoChannel.input)
  previewPiano.maxPolyphony = 8
  const pad = new Tone.PolySynth({
    context,
    voice: Tone.Synth,
    maxPolyphony: 12,
    volume: -25,
    options: {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.22, decay: 0.35, sustain: 0.6, release: 0.9 }
    }
  }).connect(pianoChannel.input)
  const click = new Tone.Synth({
    context,
    volume: -27,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.025, sustain: 0, release: 0.008 }
  }).connect(output)
  const forestBank = new ForestBank(
    context,
    treeChannel.input,
    forest,
    context.isOffline
  )
  try {
    await forestBank.ready()
  } catch (error) {
    forestBank.dispose()
    for (const node of [
      sequencePiano,
      livePiano,
      previewPiano,
      pad,
      click,
      pianoChannel,
      treeChannel,
      output,
      limiter,
      meter
    ])
      node.dispose()
    throw error
  }
  let disposed = false
  return {
    output,
    meter,
    pad,
    click,
    forest: forestBank,
    instruments: { piano: sequencePiano, tree: forestBank },
    live: { piano: livePiano, tree: forestBank },
    previewPiano,
    releaseAll(time) {
      sequencePiano.releaseAll(time)
      livePiano.releaseAll(time)
      previewPiano.releaseAll(time)
      pad.releaseAll(time)
      click.triggerRelease(time)
      forestBank.releaseAll(time)
    },
    dispose() {
      if (disposed) return
      disposed = true
      forestBank.dispose()
      for (const node of [
        sequencePiano,
        livePiano,
        previewPiano,
        pad,
        click,
        pianoChannel,
        treeChannel,
        output,
        limiter,
        meter
      ])
        node.dispose()
    }
  }
}

function runtimeState() {
  return { held: [], chord: [] }
}

function releaseHeld(graph, held, time) {
  if (held.track === 'tree') graph.instruments.tree.release(held.voice, time)
  else graph.instruments.piano.release(held.voice, time)
}

function attackNote(graph, note, absoluteTick, time, runtime) {
  const instrument = graph.instruments[note.track]
  const voice = instrument.attack(note.midi, time, note.velocity)
  if (!voice) return null
  runtime.held.push({ ...note, voice, end: absoluteTick + note.duration })
  return note.track === 'tree'
    ? { ...note, requestedMidi: note.midi, ...voice }
    : note
}

function playChord(graph, project, bar, time, runtime) {
  if (runtime.chord.length) graph.pad.triggerRelease(runtime.chord, time)
  runtime.chord = [...(CHORDS[project.chords[bar]]?.notes ?? [])]
  if (runtime.chord.length) graph.pad.triggerAttack(runtime.chord, time, 0.6)
}

function performTick(graph, project, absoluteTick, time, runtime) {
  const tick = absoluteTick % project.totalTicks
  runtime.held = runtime.held.filter((held) => {
    if (held.end <= absoluteTick || project.tracks[held.track].muted) {
      releaseHeld(graph, held, time)
      return false
    }
    return true
  })
  if (tick % TICKS_PER_BAR === 0)
    playChord(graph, project, tick / TICKS_PER_BAR, time, runtime)
  if (project.metronome && tick % TICKS_PER_BEAT === 0) {
    graph.click.triggerAttackRelease(
      tick % TICKS_PER_BAR === 0 ? 1200 : 800,
      0.035,
      time,
      0.6
    )
  }
  const notes = (project.events.get(tick) ?? []).filter(
    (note) => !project.tracks[note.track].muted && note.velocity > 0
  )
  return notes
    .map((note) => attackNote(graph, note, absoluteTick, time, runtime))
    .filter(Boolean)
}

export class AudioEngine {
  constructor(callbacks = {}) {
    this._state = 'ready'
    this._project = null
    this._graph = null
    this._transport = null
    this._scheduleId = null
    this._readyPromise = null
    this._generation = 0
    this._position = 0
    this._startTime = 0
    this._runtime = runtimeState()
    this._manual = new Map()
    this._callbacks = callbacks
    this._volume = 0.65
    this._forestAudition = false
    this._forestSignature = ''
    this._graphPromise = null
  }

  get state() {
    return this._state
  }
  get forestAudition() {
    return this._forestAudition
  }
  get forestStats() {
    return (
      this._graph?.forest.stats ?? {
        branchCount: 0,
        rms: 0,
        peak: 0,
        rainCount: 0
      }
    )
  }

  setCallbacks(callbacks) {
    this._callbacks = { ...this._callbacks, ...callbacks }
  }

  get meter() {
    if (!this._graph) return 0
    const value = this._graph.meter.getValue()
    return clamp(Array.isArray(value) ? Math.max(...value) : value, 0, 1)
  }

  async ensureReady() {
    if (!this._readyPromise) {
      this._readyPromise = Tone.start().catch((error) => {
        this._readyPromise = null
        throw error
      })
    }
    await this._readyPromise
    if (Tone.getContext().state !== 'running') await Tone.start()
    Tone.getContext().lookAhead = 0.04
    if (!this._transport) {
      this._transport = Tone.getTransport()
      this._transport.timeSignature = 4
      this._transport.loop = false
    }
    if (!this._graph) {
      if (!this._graphPromise) {
        this._graphPromise = createSoundGraph(
          Tone.getContext(),
          this._volume,
          this._project?.forest ?? createDefaultForest()
        )
          .then((graph) => {
            this._graph = graph
            graph.output.gain.value = this._volume
            graph.forest.configure(
              this._project?.forest ?? createDefaultForest()
            )
            graph.forest.onBranch = (event) => {
              const generation = this._generation
              Tone.getDraw().schedule(() => {
                if (this._graph === graph && generation === this._generation)
                  this._callbacks.onBranch?.(event)
              }, event.time)
            }
            this._syncForest()
            return graph
          })
          .finally(() => {
            this._graphPromise = null
          })
      }
      await this._graphPromise
    }
    return this
  }

  async play(project, callbacks = {}) {
    this.updateProject(project)
    this.setCallbacks(callbacks)
    if (this._state === 'playing') return
    const resume = this._state === 'paused'
    const generation = ++this._generation
    await this.ensureReady()
    if (generation !== this._generation) return
    const total = this._project.totalTicks
    const position = resume ? Math.min(this._position, total - 0.001) : 0
    this._position = position
    this._runtime = runtimeState()
    this._transport.stop()
    this._transport.bpm.value = this._project.bpm
    this._startTime = Tone.now() + 0.025
    this._state = 'playing'
    this._syncForest(this._startTime)
    if (resume && position > 0) {
      playChord(
        this._graph,
        this._project,
        Math.floor(position / TICKS_PER_BAR),
        this._startTime,
        this._runtime
      )
      for (const track of TRACKS) {
        if (this._project.tracks[track].muted) continue
        for (const note of this._project.tracks[track].notes) {
          if (note.start < position && note.start + note.duration > position) {
            attackNote(
              this._graph,
              { ...note, duration: note.start + note.duration - position },
              position,
              this._startTime,
              this._runtime
            )
          }
        }
      }
    }
    this._scheduleId = this._transport.scheduleRepeat(
      (time) => {
        if (generation !== this._generation || this._state !== 'playing') return
        const absoluteTick = Math.round(
          this._transport.getTicksAtTime(time) /
            (this._transport.PPQ / TICKS_PER_BEAT)
        )
        if (!this._project.loop && absoluteTick >= this._project.totalTicks) {
          this._finish(time, generation)
          return
        }
        const notes = performTick(
          this._graph,
          this._project,
          absoluteTick,
          time,
          this._runtime
        )
        Tone.getDraw().schedule(() => {
          if (generation !== this._generation || this._state !== 'playing')
            return
          const tick = absoluteTick % this._project.totalTicks
          this._callbacks.onTick?.(tick)
          for (const note of notes)
            this._callbacks.onNote?.({ ...note, tick, source: 'sequence' })
        }, time)
      },
      '32n',
      0
    )
    this._transport.start(
      this._startTime,
      `${(position * this._transport.PPQ) / TICKS_PER_BEAT}i`
    )
  }

  _finish(time, generation) {
    this._forestAudition = false
    this._graph.releaseAll(time)
    this._manual.clear()
    this._clearSchedule()
    this._transport.stop(time)
    Tone.getDraw().schedule(() => {
      if (generation !== this._generation) return
      this._position = this._project.totalTicks
      this._state = 'ready'
      this._runtime = runtimeState()
      this._callbacks.onEnded?.()
    }, time)
  }

  _clearSchedule() {
    if (this._scheduleId !== null && this._transport)
      this._transport.clear(this._scheduleId)
    this._scheduleId = null
  }

  _retireGraph() {
    const graph = this._graph
    if (!graph) return
    this._graph = null
    const time = Tone.immediate()
    graph.releaseAll(time)
    graph.output.gain.cancelScheduledValues(time)
    graph.output.gain.setValueAtTime(graph.output.gain.value, time)
    graph.output.gain.linearRampToValueAtTime(0, time + 0.012)
    setTimeout(() => graph.dispose(), 35)
    this._manual.clear()
  }

  pause() {
    if (this._state !== 'playing') return
    this._position = this.getTick()
    this._generation += 1
    this._forestAudition = false
    this._clearSchedule()
    this._transport?.stop(Tone.immediate())
    this._retireGraph()
    this._runtime = runtimeState()
    this._state = 'paused'
  }

  stop() {
    this._generation += 1
    this._forestAudition = false
    this._clearSchedule()
    this._transport?.stop(Tone.immediate())
    this._retireGraph()
    this._runtime = runtimeState()
    this._position = 0
    this._state = 'ready'
  }

  updateProject(project) {
    this._project = compileProject(project)
    this.setBpm(this._project.bpm)
    this.setVolume(this._project.volume)
    const signature = JSON.stringify(this._project.forest)
    if (signature !== this._forestSignature) {
      this._forestSignature = signature
      this._graph?.forest.configure(this._project.forest)
    }
    this._syncForest()
  }

  _syncForest(time = Tone.immediate()) {
    if (!this._graph) return
    const muted = Boolean(this._project?.tracks.tree.muted)
    this._graph.forest.setMuted(muted, time)
    this._graph.forest.setAmbient(
      !muted && (this._state === 'playing' || this._forestAudition),
      time
    )
  }

  setForestAudition(enabled) {
    this._forestAudition = Boolean(enabled)
    this._syncForest()
  }

  async previewBranch(branchId, velocity = 0.8) {
    const generation = this._generation
    if (!this._graph) await this.ensureReady()
    if (generation !== this._generation) return
    const voice = this._graph.forest.strikeBranch(
      branchId,
      Tone.immediate() + 0.008,
      velocity,
      'branch'
    )
    if (voice)
      this._callbacks.onNote?.({
        ...voice,
        track: 'tree',
        source: 'branch',
        duration: 0,
        velocity
      })
  }

  setBpm(bpm) {
    const value = clamp(number(bpm, 72), 30, 200)
    if (this._project) this._project.bpm = value
    if (this._transport) this._transport.bpm.value = value
  }

  setVolume(volume) {
    this._volume = clamp(number(volume, 0.65), 0, 1)
    if (this._project) this._project.volume = this._volume
    if (this._graph) this._graph.output.gain.rampTo(this._volume, 0.03)
  }

  setMetronome(enabled) {
    if (this._project) this._project.metronome = Boolean(enabled)
  }

  getTick() {
    if (this._state !== 'playing' || !this._transport || !this._project)
      return this._position
    if (Tone.immediate() < this._startTime) return this._position
    const tick = this._transport.ticks / (this._transport.PPQ / TICKS_PER_BEAT)
    return this._project.loop
      ? tick % this._project.totalTicks
      : Math.min(tick, this._project.totalTicks)
  }

  noteOn(midi, track = 'piano') {
    if (!this._graph || !TRACKS.includes(track)) return
    const key = `${track}:${midi}`
    if (this._manual.has(key)) return
    const value = clamp(Math.round(number(midi, 60)), 21, 108)
    const time = Tone.immediate() + 0.008
    const instrument = this._graph.live[track]
    const voice =
      track === 'tree'
        ? instrument.attack(value, time, 0.7)
        : instrument.triggerAttack(midiToNote(value), time, 0.65)
    if (!voice) return
    this._manual.set(key, { voice, midi: value, track })
    this._callbacks.onNote?.({
      midi: value,
      ...(track === 'tree' ? { ...voice, requestedMidi: value } : {}),
      track,
      duration: 4,
      velocity: 0.7,
      tick: this.getTick(),
      source: 'live'
    })
  }

  noteOff(midi, track = 'piano') {
    const key = `${track}:${midi}`
    const held = this._manual.get(key)
    if (!held || !this._graph) return
    const time = Tone.immediate() + 0.008
    if (track === 'tree') this._graph.live.tree.release(held.voice, time)
    else this._graph.live.piano.triggerRelease(midiToNote(held.midi), time)
    this._manual.delete(key)
  }

  preview(midi, track = 'piano') {
    if (!this._graph || !TRACKS.includes(track)) return
    const value = clamp(Math.round(number(midi, 60)), 21, 108)
    const time = Tone.now()
    let voice = null
    if (track === 'tree') {
      voice = this._graph.live.tree.attack(value, time, 0.65, 'preview')
      if (!voice) return
      this._graph.live.tree.release(voice, time + 0.2)
    } else
      this._graph.previewPiano.triggerAttackRelease(
        midiToNote(value),
        0.22,
        time,
        0.65
      )
    this._callbacks.onNote?.({
      midi: value,
      ...(track === 'tree' ? { ...voice, requestedMidi: value } : {}),
      track,
      duration: 2,
      velocity: 0.65,
      tick: this.getTick(),
      source: 'preview'
    })
  }

  releaseAll() {
    this._graph?.releaseAll(Tone.now())
    this._manual.clear()
    this._runtime = runtimeState()
  }

  releaseManual() {
    if (this._graph) {
      const time = Tone.immediate() + 0.008
      this._graph.live.piano.releaseAll(time)
      for (const held of this._manual.values())
        if (held.track === 'tree') this._graph.forest.release(held.voice, time)
    }
    this._manual.clear()
  }

  renderOffline(project, options) {
    return renderOffline(project, options)
  }
}

export async function renderOffline(project, { cycles = 1 } = {}) {
  const compiled = compileProject(project)
  const cycleCount = clamp(Math.round(number(cycles, 1)), 1, 4)
  const musicDuration = ((compiled.bars * 4 * 60) / compiled.bpm) * cycleCount
  const duration = musicDuration + TAIL_SECONDS
  const context = new Tone.OfflineContext(2, duration, 44100)
  const graph = await createSoundGraph(
    context,
    compiled.volume,
    compiled.forest
  )
  graph.forest.prepareOffline(compiled, duration, cycleCount)
  const forestStats = { ...graph.forest.stats }
  const clockProject = {
    ...compiled,
    tracks: {
      ...compiled.tracks,
      tree: { ...compiled.tracks.tree, muted: true }
    }
  }
  const transport = context.transport
  const runtime = runtimeState()
  transport.bpm.value = compiled.bpm
  transport.timeSignature = 4
  let absoluteTick = 0
  const repeat = transport.scheduleRepeat(
    (time) => {
      performTick(graph, clockProject, absoluteTick, time, runtime)
      absoluteTick += 1
    },
    '32n',
    0,
    musicDuration
  )
  transport.scheduleOnce((time) => {
    graph.releaseAll(time)
    transport.clear(repeat)
    transport.stop(time)
  }, musicDuration)
  transport.start(0)
  let buffer
  try {
    buffer = await context.render()
  } finally {
    graph.dispose()
    context.dispose()
  }
  let peak = 0
  let squares = 0
  let tailSquares = 0
  let count = 0
  let tailCount = 0
  const tailStart = Math.floor((duration - 0.5) * buffer.sampleRate)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]
      peak = Math.max(peak, Math.abs(sample))
      squares += sample * sample
      count += 1
      if (index >= tailStart) {
        tailSquares += sample * sample
        tailCount += 1
      }
    }
  }
  return {
    duration: buffer.duration,
    musicDuration,
    peak,
    rms: Math.sqrt(squares / count),
    tailRms: Math.sqrt(tailSquares / tailCount),
    forestStats,
    buffer
  }
}
