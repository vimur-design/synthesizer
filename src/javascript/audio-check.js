import * as Tone from 'tone'
import { AudioEngine, renderOffline } from './audio-engine.js'
import { createDemoProject, cloneProject } from './model.js'
import { generateForest } from './forest-model.js'
import { nearestBranch } from './forest-audio.js'

function reportFor(name, project, rendered, audible, extraChecks = {}) {
  const { duration, musicDuration, peak, rms, tailRms } = rendered
  const expectedDuration = (project.bars * 4 * 60) / project.bpm + 4
  const checks = {
    duration: Math.abs(duration - expectedDuration) < 0.001,
    finite: [peak, rms, tailRms].every(Number.isFinite),
    signal: audible ? rms > 0.0001 : peak < 0.000001,
    headroom: peak < 0.95,
    ending: tailRms < Math.max(0.0001, rms * 0.02),
    ...extraChecks
  }
  return {
    name,
    pass: Object.values(checks).every(Boolean),
    duration,
    expectedDuration,
    musicDuration,
    peak,
    rms,
    tailRms,
    forest: rendered.forestStats,
    checks
  }
}

function channelRms(buffer) {
  return [0, 1].map((channel) => {
    const samples = buffer.getChannelData(channel)
    return Math.sqrt(
      samples.reduce((sum, value) => sum + value * value, 0) / samples.length
    )
  })
}

function compareWindow(actual, reference, start, end) {
  let actualSquares = 0
  let referenceSquares = 0
  let errorSquares = 0
  let count = 0
  for (let channel = 0; channel < actual.numberOfChannels; channel += 1) {
    const actualSamples = actual.getChannelData(channel)
    const referenceSamples = reference.getChannelData(channel)
    const first = Math.ceil(start * actual.sampleRate)
    const last = Math.min(
      actualSamples.length,
      referenceSamples.length,
      Math.floor(end * actual.sampleRate)
    )
    for (let index = first; index < last; index += 1) {
      actualSquares += actualSamples[index] ** 2
      referenceSquares += referenceSamples[index] ** 2
      errorSquares += (actualSamples[index] - referenceSamples[index]) ** 2
      count += 1
    }
  }
  const actualRms = Math.sqrt(actualSquares / count)
  const referenceRms = Math.sqrt(referenceSquares / count)
  const errorRms = Math.sqrt(errorSquares / count)
  return {
    start,
    end,
    actualRms,
    referenceRms,
    errorRms,
    relativeError: errorRms / referenceRms
  }
}

async function checkOverlap(demo, { name, longStart, shortStart }) {
  const reference = cloneProject(demo)
  reference.bpm = 60
  reference.bars = 2
  reference.chords = ['rest', 'rest']
  reference.tracks.tree.notes = []
  reference.tracks.tree.muted = true
  reference.tracks.piano.notes = [
    {
      id: 'qa-long',
      midi: 60,
      start: longStart,
      duration: 48 - longStart,
      velocity: 0.6
    }
  ]
  const overlapping = cloneProject(reference)
  overlapping.tracks.piano.notes.push({
    id: 'qa-short',
    midi: 60,
    start: shortStart,
    duration: 4,
    velocity: 0.6
  })
  const referenceRender = await renderOffline(reference)
  const overlappingRender = await renderOffline(overlapping)
  // At 60 BPM both short notes and their release/delay tails have died away
  // before 3.5 s. The long C4 is still held until 6 s. Matching the waveform
  // catches releasing the wrong same-pitch voice, even when its RMS is similar.
  const window = compareWindow(
    overlappingRender.buffer,
    referenceRender.buffer,
    3.5,
    5.5
  )
  const result = reportFor(name, overlapping, overlappingRender, true, {
    longNoteContinues:
      window.actualRms > 0.0001 && window.referenceRms > 0.0001,
    correctVoiceReleased:
      Number.isFinite(window.relativeError) && window.relativeError < 0.05
  })
  result.window = window
  referenceRender.buffer.dispose()
  overlappingRender.buffer.dispose()
  return result
}

/** Each isolated layer must produce signal; an explicitly silent score must not. */
export async function runAudioChecks() {
  const demo = createDemoProject()
  demo.loop = false
  const piano = cloneProject(demo)
  piano.chords.fill('rest')
  piano.tracks.tree.muted = true
  const harmony = cloneProject(demo)
  harmony.tracks.piano.notes = []
  harmony.tracks.tree.muted = true
  const tree = cloneProject(demo)
  tree.chords.fill('rest')
  tree.tracks.piano.muted = true
  tree.forest.noise = tree.forest.rain = tree.forest.thru = 0
  const silence = cloneProject(demo)
  silence.chords.fill('rest')
  silence.tracks.piano.muted = true
  silence.tracks.tree.muted = true
  const fast = cloneProject(demo)
  fast.bpm = 180
  const cases = [
    ['Полная композиция', demo, true],
    ['Пиано отдельно', piano, true],
    ['Гармония отдельно', harmony, true],
    ['Ветви отдельно', tree, true],
    ['Выключенные партии и паузы', silence, false],
    ['Композиция при 180 BPM', fast, true]
  ]
  const results = []
  // Sequential rendering keeps memory bounded and contexts independent.
  for (const [name, project, audible] of cases) {
    const rendered = await renderOffline(project)
    const extra = {}
    const channels = channelRms(rendered.buffer)
    if (project === piano || project === harmony)
      extra.pianoBusLeft = channels[0] > channels[1] * 1.3
    const result = reportFor(name, project, rendered, audible, extra)
    result.channelRms = channels
    results.push(result)
    rendered.buffer.dispose()
  }
  results.push(
    await checkOverlap(demo, {
      name: 'Один MIDI: вторая долгая нота продолжает звучать',
      longStart: 2,
      shortStart: 0
    })
  )
  results.push(
    await checkOverlap(demo, {
      name: 'Один MIDI: короткая вторая нота не обрывает первую',
      longStart: 0,
      shortStart: 8
    })
  )
  const forestOnly = () => {
    const project = cloneProject(demo)
    project.tracks.piano.muted = true
    project.tracks.piano.notes = []
    project.tracks.tree.notes = []
    project.chords.fill('rest')
    project.forest.noise = project.forest.rain = project.forest.thru = 0
    return project
  }
  const noise = forestOnly()
  noise.forest.noise = 0.7
  const rain = forestOnly()
  rain.forest.rain = 0.8
  rain.forest.rainSpeed = 5
  const stereo = forestOnly()
  stereo.forest.noise = 0.7
  stereo.forest.pan = 1
  // Thru feeds the same signal into both DSP channels, isolating the tree
  // bus's own pan from the positions and frequencies of individual branches.
  const treeBus = forestOnly()
  treeBus.forest.thru = 0.5
  treeBus.forest.wind = 0
  const stereoLeft = forestOnly()
  stereoLeft.forest.noise = 0.7
  stereoLeft.forest.pan = -1
  stereoLeft.forest.trees.forEach((entry) => {
    entry.x = 0.08
    entry.width = 0.25
  })
  const disabled = forestOnly()
  disabled.forest.noise = disabled.forest.rain = disabled.forest.thru = 0.8
  disabled.forest.trees.forEach((entry) => {
    entry.enabled = false
  })
  const muted = cloneProject(noise)
  muted.forest.rain = 0.8
  muted.forest.thru = 0.8
  muted.tracks.tree.muted = true
  for (const [name, project, audible] of [
    ['Лес: только шумовой возбудитель', noise, true],
    ['Лес: только дождевые удары', rain, true],
    ['Дерево: отдельный голос смещён вправо', treeBus, true],
    ['Лес: стереопанорама вправо', stereo, true],
    ['Лес: левый канал сохраняется после панорамы голоса', stereoLeft, true],
    ['Лес: выключенные деревья молчат', disabled, false],
    ['Лес: mute партии гасит шум, дождь и Thru', muted, false]
  ]) {
    const rendered = await renderOffline(project)
    const extra = {}
    if (project === rain) extra.rainStrikes = rendered.forestStats.rainCount > 5
    let channels
    if (project === stereo || project === treeBus || project === stereoLeft) {
      channels = channelRms(rendered.buffer)
    }
    if (project === stereo) extra.stereoPan = channels[1] > channels[0] * 1.3
    if (project === treeBus)
      extra.treeBusRight = channels[1] > channels[0] * 1.3
    if (project === stereoLeft)
      extra.stereoPreserved = channels[0] > channels[1] * 1.3
    const result = reportFor(name, project, rendered, audible, extra)
    if (channels) result.channelRms = channels
    results.push(result)
    rendered.buffer.dispose()
  }
  return { pass: results.every((result) => result.pass), results }
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Exercise the actual AudioWorklet, including its asynchronous lifecycle. */
export async function runRuntimeChecks() {
  const engine = new AudioEngine()
  const project = createDemoProject()
  project.loop = true
  project.tracks.piano.notes = []
  project.tracks.tree.notes = []
  project.tracks.piano.muted = true
  project.chords.fill('rest')
  project.forest.noise = 0.65
  project.forest.rain = 0
  project.forest.filter = 440
  project.forest.bandwidth = 3
  project.forest.wind = 0
  const results = []
  let monitor
  const add = (name, checks, metrics = {}) =>
    results.push({
      name,
      pass: Object.values(checks).every(Boolean),
      checks,
      ...metrics
    })
  const measure = async (milliseconds = 300) => {
    let peakRms = 0
    const end = performance.now() + milliseconds
    while (performance.now() < end) {
      await wait(25)
      const value = monitor.getValue()
      peakRms = Math.max(
        peakRms,
        Array.isArray(value) ? Math.max(...value) : value
      )
    }
    return peakRms
  }
  try {
    engine.updateProject(project)
    await engine.ensureReady()
    // This monitor stays connected after a graph is retired, so it catches
    // old nodes still reaching the actual master output after Stop/Pause.
    monitor = new Tone.Meter({ normalRange: true, smoothing: 0 })
    Tone.getDestination().connect(monitor)
    const initiallySilent = await measure(180)
    add(
      'Worklet: готовность не запускает шум сама',
      { silence: initiallySilent < 0.000001 },
      { rms: initiallySilent }
    )
    engine.setForestAudition(true)
    const audible = await measure(450)
    add(
      'Worklet: standalone шумовой лес звучит',
      {
        signal: audible > 0.0001,
        modes: engine.forestStats.branchCount > 0,
        noError: !engine.forestStats.error
      },
      { rms: audible, forest: { ...engine.forestStats } }
    )
    engine.setForestAudition(false)
    await wait(900)
    const auditionStopped = await measure(180)
    add(
      'Worklet: остановка standalone затухает',
      { silence: auditionStopped < 0.0001, audition: !engine.forestAudition },
      { rms: auditionStopped }
    )
    engine.setForestAudition(true)
    const restarted = await measure(450)
    add(
      'Worklet: повторное standalone прослушивание',
      { signal: restarted > 0.0001 },
      { rms: restarted }
    )
    engine.setForestAudition(false)
    await wait(400)
    await engine.play(project)
    const selected = nearestBranch(generateForest(project.forest).branches, 69)
    engine.noteOn(69, 'tree')
    await wait(90)
    engine.releaseManual()
    const manualReleased = await measure(500)
    const strikeCount = engine.forestStats.strikeCount
    add(
      'Worklet: отпускание ручной игры сохраняет композицию',
      { signal: manualReleased > 0.0001, playing: engine.state === 'playing' },
      { rms: manualReleased }
    )
    const changed = cloneProject(project)
    changed.bpm = 142
    changed.forest.tuning = 67
    changed.forest.algorithm = 0.8
    changed.forest.filter = 900
    engine.updateProject(changed)
    const edited = await measure(450)
    add(
      'Worklet: live темп и параметры не сбрасывают банк',
      {
        signal: edited > 0.0001,
        preservedStrikes: engine.forestStats.strikeCount >= strikeCount,
        playing: engine.state === 'playing'
      },
      { rms: edited, forest: { ...engine.forestStats } }
    )
    const muted = cloneProject(changed)
    muted.tracks.tree.muted = true
    engine.updateProject(muted)
    await wait(1100)
    const mutedLevel = await measure(180)
    add(
      'Worklet: mute партии действительно гасит лес',
      { silence: mutedLevel < 0.0001 },
      { rms: mutedLevel }
    )
    engine.updateProject(changed)
    await measure(350)
    engine.pause()
    await wait(100)
    const paused = await measure(180)
    add(
      'Worklet: Pause без старых голосов',
      {
        silence: paused < 0.000001,
        paused: engine.state === 'paused',
        audition: !engine.forestAudition
      },
      { rms: paused }
    )
    await engine.play(changed)
    await measure(350)
    engine.stop()
    await wait(100)
    const stopped = await measure(180)
    add(
      'Worklet: Stop без старых голосов',
      {
        silence: stopped < 0.000001,
        ready: engine.state === 'ready',
        audition: !engine.forestAudition
      },
      { rms: stopped }
    )
    await engine.ensureReady()
    const silentReady = await measure(180)
    add(
      'Worklet: готовность после Stop не возобновляет шум',
      { silence: silentReady < 0.000001 },
      { rms: silentReady }
    )
    const current = nearestBranch(
      generateForest(changed.forest).branches,
      selected.midi
    )
    await engine.previewBranch(current.id, 0.9)
    const strikeLevel = await measure(300)
    add(
      'Worklet: ветвь играет отдельно при остановленном транспорте',
      {
        signal: strikeLevel > 0.00001,
        ready: engine.state === 'ready',
        noAmbient: !engine.forestAudition
      },
      { rms: strikeLevel }
    )
  } finally {
    engine.stop()
    if (monitor) {
      Tone.getDestination().disconnect(monitor)
      monitor.dispose()
    }
  }
  return { pass: results.every((result) => result.pass), results }
}

/** Check the realtime sequencer separately from the forest's ambient sound. */
export async function runPlaybackChecks() {
  const engine = new AudioEngine()
  const project = createDemoProject()
  project.loop = true
  project.metronome = false
  project.chords.fill('rest')
  project.tracks.piano.muted = false
  project.tracks.tree.muted = true
  project.tracks.tree.notes = []
  project.forest.noise = project.forest.rain = project.forest.thru = 0
  const context = Tone.getContext()
  const transport = Tone.getTransport()
  const snapshots = {}
  const ticks = []
  const notes = []
  let monitor
  let peakRms = 0
  let wallSeconds = 0
  let error
  const snapshot = () => ({
    state: context.state,
    rawState: context.rawContext.state,
    currentTime: context.rawContext.currentTime,
    immediate: Tone.immediate(),
    clockSource: context.clockSource,
    updateInterval: context.updateInterval,
    lookAhead: context.lookAhead,
    transportState: transport.state,
    transportTicks: transport.ticks,
    transportSeconds: transport.seconds,
    engineState: engine.state,
    position: engine.getTick()
  })
  const bounded = (promise, milliseconds, message) =>
    Promise.race([
      promise,
      wait(milliseconds).then(() => {
        throw new Error(message)
      })
    ])
  engine.updateProject(project)
  snapshots.beforeResume = snapshot()
  // No await precedes Tone.start: the click's user activation reaches resume.
  const resumePromise = Tone.start()
  try {
    await bounded(
      resumePromise,
      4000,
      'AudioContext.resume не завершился за 4 с'
    )
    snapshots.afterResume = snapshot()
    monitor = new Tone.Meter({ normalRange: true, smoothing: 0 })
    Tone.getDestination().connect(monitor)
    await bounded(
      engine.play(project, {
        onTick: (tick) => ticks.push(tick),
        onNote: (note) => notes.push({ midi: note.midi, tick: note.tick })
      }),
      5000,
      'Запуск AudioEngine не завершился за 5 с'
    )
    snapshots.beforePlayback = snapshot()
    const start = performance.now()
    while (performance.now() - start < 1000) {
      await wait(25)
      const value = monitor.getValue()
      peakRms = Math.max(
        peakRms,
        Array.isArray(value) ? Math.max(...value) : value
      )
    }
    wallSeconds = (performance.now() - start) / 1000
    snapshots.afterPlayback = snapshot()
  } catch (caught) {
    error = { name: caught.name, message: caught.message, stack: caught.stack }
    snapshots.failed = snapshot()
  } finally {
    engine.stop()
    if (monitor) {
      Tone.getDestination().disconnect(monitor)
      monitor.dispose()
    }
    snapshots.afterStop = snapshot()
  }
  const before = snapshots.beforePlayback
  const after = snapshots.afterPlayback
  const audioSeconds =
    before && after ? after.currentTime - before.currentTime : 0
  const transportTicks =
    before && after ? after.transportTicks - before.transportTicks : 0
  const checks = {
    noError: !error,
    running: after?.state === 'running',
    audioClock: audioSeconds > 0.1,
    transportProgress: transportTicks > 0,
    tickCallbacks: ticks.length > 0,
    noteCallbacks: notes.length > 0,
    pianoSignal: peakRms > 0.0001
  }
  const diagnosis = error
    ? 'start-error'
    : !checks.audioClock
      ? 'audio-clock-stalled'
      : !checks.transportProgress
        ? 'transport-stalled'
        : !checks.tickCallbacks
          ? 'scheduler-no-callbacks'
          : !checks.pianoSignal
            ? 'piano-silent'
            : 'playback-running'
  return {
    pass: Object.values(checks).every(Boolean),
    diagnosis,
    checks,
    wallSeconds,
    audioSeconds,
    transportTicks,
    peakRms,
    tickCount: ticks.length,
    noteCount: notes.length,
    ticks,
    notes,
    snapshots,
    ...(error ? { error } : {})
  }
}

function mount() {
  const host =
    document.querySelector('#audio-check') ??
    document.body.appendChild(document.createElement('main'))
  host.style.cssText =
    'max-width:850px;margin:40px auto;padding:24px;font:16px/1.6 system-ui;color:#e5e8e0;background:#1e2927;border-radius:20px'
  document.body.style.cssText = 'margin:0;background:#101a19'
  document.title = 'Вимузыка • Проверка звука'
  const heading = document.createElement('h1')
  heading.textContent = 'Проверка звукового движка'
  const explanation = document.createElement('p')
  explanation.textContent =
    'Рендерим тот же звуковой граф без воспроизведения через динамики. Проверяем сигнал, затухание, темп 180 BPM и независимые длительности перекрывающихся нот одной высоты.'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Проверить звук'
  button.style.cssText =
    'font:inherit;padding:12px 18px;border:0;border-radius:12px;background:#d8dfbf;color:#18211f;cursor:pointer'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const output = document.createElement('pre')
  output.style.cssText = 'overflow:auto;white-space:pre-wrap;font-size:13px'
  const runtimeButton = document.createElement('button')
  runtimeButton.type = 'button'
  runtimeButton.textContent = 'Проверить AudioWorklet вживую'
  runtimeButton.style.cssText = button.style.cssText + ';margin-left:12px'
  const playbackButton = document.createElement('button')
  playbackButton.type = 'button'
  playbackButton.textContent = 'Проверить запуск мелодии'
  playbackButton.style.cssText = button.style.cssText + ';margin:12px 0'
  host.append(
    heading,
    explanation,
    button,
    runtimeButton,
    playbackButton,
    status,
    output
  )
  button.addEventListener('click', async () => {
    button.disabled = true
    runtimeButton.disabled = true
    playbackButton.disabled = true
    status.textContent =
      'Рендерим звук и сравниваем перекрывающиеся ноты с эталоном…'
    output.textContent = ''
    try {
      const report = await runAudioChecks()
      status.textContent = report.pass
        ? 'PASS — все звуковые проверки пройдены'
        : 'FAIL — одна или несколько проверок не пройдены'
      output.textContent = JSON.stringify(report, null, 2)
      host.dataset.result = report.pass ? 'pass' : 'fail'
      console.info('Вимузыка: audio QA', report)
    } catch (error) {
      status.textContent = 'FAIL — ошибка рендеринга'
      output.textContent = error.stack ?? String(error)
      host.dataset.result = 'fail'
      console.error(error)
    } finally {
      button.disabled = false
      runtimeButton.disabled = false
      playbackButton.disabled = false
    }
  })
  runtimeButton.addEventListener('click', async () => {
    button.disabled = runtimeButton.disabled = playbackButton.disabled = true
    status.textContent =
      'Проверяем настоящий AudioWorklet. Будет слышен короткий шумовой фрагмент…'
    output.textContent = ''
    try {
      const report = await runRuntimeChecks()
      status.textContent = report.pass
        ? 'PASS — AudioWorklet и его жизненный цикл проверены'
        : 'FAIL — runtime проверка не пройдена'
      output.textContent = JSON.stringify(report, null, 2)
      host.dataset.runtimeResult = report.pass ? 'pass' : 'fail'
    } catch (error) {
      status.textContent = 'FAIL — ошибка AudioWorklet'
      output.textContent = error.stack ?? String(error)
      host.dataset.runtimeResult = 'fail'
    } finally {
      button.disabled = runtimeButton.disabled = playbackButton.disabled = false
    }
  })
  playbackButton.addEventListener('click', async () => {
    button.disabled = runtimeButton.disabled = playbackButton.disabled = true
    status.textContent = 'Проверяем аудиочасы, секвенсор и сигнал пиано…'
    output.textContent = ''
    try {
      const report = await runPlaybackChecks()
      status.textContent = report.pass
        ? 'PASS — мелодия запускается, аудиочасы и секвенсор работают'
        : `FAIL — ${report.diagnosis}`
      output.textContent = JSON.stringify(report, null, 2)
      host.dataset.playbackResult = report.pass ? 'pass' : 'fail'
    } catch (error) {
      status.textContent = 'FAIL — ошибка проверки мелодии'
      output.textContent = error.stack ?? String(error)
      host.dataset.playbackResult = 'fail'
    } finally {
      button.disabled = runtimeButton.disabled = playbackButton.disabled = false
    }
  })
}

if (typeof document !== 'undefined') mount()
