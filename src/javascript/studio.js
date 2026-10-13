import {
  CHORDS,
  TRACKS,
  MIN_MIDI,
  MAX_MIDI,
  TICKS_PER_BEAT,
  TICKS_PER_BAR,
  createDemoProject,
  cloneProject,
  normalizeProject,
  lengthTicks,
  gridStep,
  midiToNote,
  snapTick,
  resizeProject,
  addNote,
  removeNote,
  updateNote,
  clearTrack
} from './model.js'
import { AudioEngine } from './audio-engine.js'
import { createForestView } from './forest-view.js'

export function initStudio() {
  const STORAGE_KEY = new URLSearchParams(location.search).has('qa')
    ? 'vimuzyka-original-trees-qa-v1'
    : 'vimuzyka-original-trees-project-v1'
  let ROW_HEIGHT = 14
  let leftMode = 'notes'
  let rightMode = 'tree'
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const engine = new AudioEngine()
  const $ = (id) => document.getElementById(id)
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
  const keyMap = {
    KeyA: 60,
    KeyW: 61,
    KeyS: 62,
    KeyE: 63,
    KeyD: 64,
    KeyF: 65,
    KeyT: 66,
    KeyG: 67,
    KeyY: 68,
    KeyH: 69,
    KeyU: 70,
    KeyJ: 71,
    KeyK: 72
  }
  const keyLabels = Object.fromEntries(
    Object.entries(keyMap).map(([key, midi]) => [midi, key.slice(-1)])
  )
  let project = createDemoProject()
  let storageAvailable = true
  let restored = false
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      project = normalizeProject(JSON.parse(saved))
      restored = true
    }
  } catch {
    storageAvailable = false
  }
  let activeTrack = 'piano'
  let selectedId = null
  let newDuration = 'grid'
  let history = []
  let future = []
  let drag = null
  let rollWidth = 1000
  let playhead = null
  let audioBusy = false
  let chordSignature = ''
  let forestSignature = ''
  let forestBusy = false
  let audioIntent = 0
  let toastTimer
  const held = new Map()

  const icons = {
    play: '<path d="m9 5 11 7-11 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    undo: '<path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12"/>',
    redo: '<path d="m15 5 5 5-5 5M20 10H10a6 6 0 0 0 0 12"/>',
    loop: '<path d="m17 3 4 4-4 4M3 11V9a2 2 0 0 1 2-2h16M7 21l-4-4 4-4m14 0v2a2 2 0 0 1-2 2H3"/>'
  }
  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`
  }

  const forestView = createForestView($('forest-studio'), {
    onChange: (forest) => commit({ ...cloneProject(project), forest }),
    onPreview: (forest) => engine.updateProject({ ...project, forest }),
    onStrike: async (branchId, velocity) => {
      const intent = audioIntent
      await engine.ensureReady()
      if (intent === audioIntent) await engine.previewBranch(branchId, velocity)
    },
    onAudition: async (enabled) => {
      if (forestBusy) return engine.forestAudition
      const intent = ++audioIntent
      forestBusy = true
      try {
        if (enabled) await engine.ensureReady()
        if (intent !== audioIntent) return engine.forestAudition
        engine.setForestAudition(enabled)
        return engine.forestAudition
      } finally {
        forestBusy = false
        renderForest()
      }
    },
    onError: toast
  })

  function toast(message) {
    $('toast').textContent = message
    $('toast').hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      $('toast').hidden = true
    }, 4800)
  }
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
      storageAvailable = true
    } catch {
      storageAvailable = false
    }
    $('save-status').textContent = storageAvailable
      ? 'Сохранено в браузере'
      : 'Сохраните проект в JSON'
  }
  function commit(next, { stop = false } = {}) {
    next = normalizeProject(next)
    if (JSON.stringify(next) === JSON.stringify(project)) return
    history.push(cloneProject(project))
    if (history.length > 50) history.shift()
    future = []
    if (stop) {
      audioIntent++
      engine.stop()
    }
    project = next
    engine.updateProject(project)
    persist()
    render()
  }
  function changeField(field, value) {
    commit({ ...cloneProject(project), [field]: value })
  }
  function undo() {
    if (!history.length) return
    audioIntent++
    engine.stop()
    releaseHeld()
    future.push(cloneProject(project))
    project = history.pop()
    selectedId = null
    engine.updateProject(project)
    persist()
    render()
  }
  function redo() {
    if (!future.length) return
    audioIntent++
    engine.stop()
    releaseHeld()
    history.push(cloneProject(project))
    project = future.pop()
    selectedId = null
    engine.updateProject(project)
    persist()
    render()
  }
  function selectedNote() {
    return project.tracks[activeTrack].notes.find(
      (note) => note.id === selectedId
    )
  }

  function renderWorkspace() {
    const treeNotes = rightMode === 'notes'
    const slot = $(treeNotes ? 'tree-note-slot' : 'piano-note-slot')
    if ($('note-editor').parentElement !== slot)
      slot.appendChild($('note-editor'))
    $('piano-note-slot').hidden = treeNotes || leftMode !== 'notes'
    $('chord-panel').hidden = !treeNotes && leftMode !== 'chords'
    $('tree-note-slot').hidden = !treeNotes
    $('forest-studio').hidden = treeNotes
    $('track-piano').setAttribute(
      'aria-selected',
      String(!treeNotes && leftMode === 'notes')
    )
    $('chords-tab').setAttribute(
      'aria-selected',
      String(treeNotes || leftMode === 'chords')
    )
    $('tree-view-tab').setAttribute('aria-selected', String(!treeNotes))
    $('track-tree').setAttribute('aria-selected', String(treeNotes))
    $('editor-track').textContent =
      `НОТЫ ${activeTrack === 'piano' ? 'ПИАНО' : 'ДЕРЕВА'}`
  }

  function renderControls() {
    $('project-name').value = project.name
    $('bpm').value = project.bpm
    $('bars').value = project.bars
    $('grid').value = project.grid
    $('volume').value = project.volume
    $('volume-value').value = `${Math.round(project.volume * 100)}%`
    $('metronome').checked = project.metronome
    $('loop').setAttribute('aria-pressed', String(project.loop))
    $('undo').disabled = !history.length
    $('redo').disabled = !future.length
    renderWorkspace()
    const muted = project.tracks[activeTrack].muted
    $('mute').textContent = muted ? 'Включить звук' : 'Приглушить'
    $('mute').setAttribute('aria-pressed', String(muted))
    $('keyboard-track').textContent = TRACKS[activeTrack].label.toUpperCase()
    $('note-count').textContent =
      `${project.tracks[activeTrack].notes.length} нот`
    const note = selectedNote()
    $('note-inspector').hidden = !note
    $('selection-info').hidden = !!note
    if (note) {
      $('note-duration').value = note.duration
      $('note-duration').max = lengthTicks(project) - note.start
      $('note-velocity').value = note.velocity
    }
    const nextChordSignature = JSON.stringify(project.chords)
    if (nextChordSignature !== chordSignature) {
      $('chords').innerHTML = project.chords
        .map(
          (chord, i) =>
            `<label class="chord-row"><span>${String(i + 1).padStart(2, '0')}</span><select data-bar="${i}" aria-label="Аккорд такта ${i + 1}">${Object.entries(
              CHORDS
            )
              .map(
                ([id, entry]) =>
                  `<option value="${id}" ${id === chord ? 'selected' : ''}>${entry.label}</option>`
              )
              .join('')}</select><small>4 доли</small></label>`
        )
        .join('')
      chordSignature = nextChordSignature
    }
    renderTransport()
  }
  function svgElement(tag, attributes, parent) {
    const element = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attributes))
      element.setAttribute(key, String(value))
    parent.appendChild(element)
    return element
  }
  function renderRoll() {
    const svg = $('roll')
    const shell = $('roll-shell')
    const shellHeight = shell.getBoundingClientRect().height
    if (shellHeight)
      ROW_HEIGHT = Math.max(
        6,
        (shellHeight - $('ruler').getBoundingClientRect().height) /
          (MAX_MIDI - MIN_MIDI + 1)
      )
    shell.style.setProperty('--row-height', `${ROW_HEIGHT}px`)
    const height = (MAX_MIDI - MIN_MIDI + 1) * ROW_HEIGHT
    const total = lengthTicks(project)
    rollWidth = Math.max($('roll-scroll').clientWidth, 1)
    svg.replaceChildren()
    svg.setAttribute('viewBox', `0 0 ${rollWidth} ${height}`)
    svg.setAttribute('width', rollWidth)
    svg.setAttribute('height', height)
    svg.style.setProperty('--track-color', TRACKS[activeTrack].color)
    $('ruler').style.width = `${rollWidth}px`
    $('ruler').innerHTML = Array.from(
      { length: project.bars * 4 },
      (_, beat) =>
        `<span class="${beat % 4 === 0 ? 'bar-number' : ''}" style="left:${(beat / (project.bars * 4)) * 100}%">${beat % 4 === 0 ? `${Math.floor(beat / 4) + 1}` : `· ${(beat % 4) + 1}`}</span>`
    ).join('')
    for (let midi = MAX_MIDI; midi >= MIN_MIDI; midi--) {
      const y = (MAX_MIDI - midi) * ROW_HEIGHT
      svgElement(
        'rect',
        {
          x: 0,
          y,
          width: rollWidth,
          height: ROW_HEIGHT,
          class: midiToNote(midi).includes('#')
            ? 'pitch-row sharp-row'
            : 'pitch-row'
        },
        svg
      )
      svgElement(
        'line',
        { x1: 0, x2: rollWidth, y1: y, y2: y, class: 'row-line' },
        svg
      )
    }
    for (let tick = 0; tick <= total; tick += gridStep(project)) {
      const x = (tick / total) * rollWidth
      svgElement(
        'line',
        {
          x1: x,
          x2: x,
          y1: 0,
          y2: height,
          class:
            tick % 32 === 0
              ? 'bar-line'
              : tick % 8 === 0
                ? 'beat-line'
                : 'grid-line'
        },
        svg
      )
    }
    for (const note of project.tracks[activeTrack].notes) {
      const x = (note.start / total) * rollWidth + 1
      const width = Math.max(3, (note.duration / total) * rollWidth - 2)
      const y = (MAX_MIDI - note.midi) * ROW_HEIGHT + 2
      const group = svgElement(
        'g',
        {
          'data-note-id': note.id,
          'data-start': note.start,
          'data-duration': note.duration,
          'data-midi': note.midi,
          class: `roll-note${note.id === selectedId ? ' selected' : ''}${project.tracks[activeTrack].muted ? ' muted' : ''}`
        },
        svg
      )
      const title = svgElement('title', {}, group)
      title.textContent = `${midiToNote(note.midi)}, такт ${Math.floor(note.start / 32) + 1}, длина ${note.duration}/32`
      svgElement(
        'rect',
        {
          x,
          y,
          width,
          height: ROW_HEIGHT - 4,
          rx: 3,
          opacity: 0.55 + note.velocity * 0.45
        },
        group
      )
      if (width > 24) {
        const text = svgElement(
          'text',
          { x: x + 5, y: y + Math.min(10, ROW_HEIGHT - 4) },
          group
        )
        text.textContent = midiToNote(note.midi)
      }
      svgElement(
        'rect',
        {
          x: x + Math.max(0, width - 7),
          y,
          width: Math.min(7, width),
          height: ROW_HEIGHT - 4,
          class: 'resize-handle',
          'data-resize': 'true'
        },
        group
      )
    }
    playhead = svgElement(
      'line',
      { x1: 0, x2: 0, y1: 0, y2: height, class: 'playhead' },
      svg
    )
  }
  function renderForest() {
    const playing = engine.state === 'playing'
    const signature = JSON.stringify([
      project.forest,
      engine.forestAudition,
      project.tracks.tree.muted,
      playing
    ])
    if (signature === forestSignature) return
    forestSignature = signature
    forestView.render(project.forest, {
      audition: engine.forestAudition,
      muted: project.tracks.tree.muted,
      playing
    })
  }
  function render() {
    renderControls()
    renderRoll()
    renderForest()
  }
  function renderTransport() {
    const playing = engine.state === 'playing'
    const mode = audioBusy ? 'loading' : engine.state
    if ($('play').dataset.mode !== mode) {
      $('play').innerHTML =
        `${icon(playing ? 'pause' : 'play')}<span>${audioBusy ? 'Запуск…' : playing ? 'Пауза' : engine.state === 'paused' ? 'Продолжить' : 'Играть'}</span>`
      $('play').dataset.mode = mode
    }
    $('play').setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести')
    $('play').disabled = audioBusy
  }
  function flashNote({ midi, requestedMidi, track, branchId }) {
    if (branchId) forestView.flash(branchId)
    midi = requestedMidi ?? midi
    const selector =
      track === activeTrack
        ? `[data-midi="${midi}"]`
        : `.piano-key[data-midi="${midi}"]`
    document.querySelectorAll(selector).forEach((element) => {
      element.classList.add('sounding')
      setTimeout(
        () => {
          if (![...held.values()].some((value) => value.midi === midi))
            element.classList.remove('sounding')
        },
        track === 'tree' ? 600 : 240
      )
    })
  }
  async function play() {
    if (audioBusy) return
    audioIntent++
    if (engine.state === 'playing') {
      releaseHeld()
      engine.pause()
      renderTransport()
      return
    }
    audioBusy = true
    renderTransport()
    try {
      await engine.play(project, {
        onNote: flashNote,
        onEnded: renderTransport
      })
    } catch (error) {
      toast(`Звук не запустился: ${error.message}`)
    } finally {
      audioBusy = false
      renderTransport()
    }
  }
  async function preview(midi, track = activeTrack) {
    const intent = audioIntent
    try {
      await engine.ensureReady()
      if (intent !== audioIntent) return
      engine.setVolume(project.volume)
      engine.preview(midi, track)
      flashNote({ midi, track })
    } catch (error) {
      toast(`Звук не запустился: ${error.message}`)
    }
  }
  async function hold(midi, source) {
    if (held.has(source)) return
    const intent = audioIntent
    const voice = { midi, track: activeTrack, started: false, tap: false }
    held.set(source, voice)
    document
      .querySelectorAll(`[data-midi="${midi}"]`)
      .forEach((key) => key.classList.add('sounding'))
    try {
      await engine.ensureReady()
      engine.setVolume(project.volume)
      if (intent !== audioIntent) return
      if (held.get(source) !== voice) {
        if (voice.tap) engine.preview(midi, voice.track)
        return
      }
      engine.noteOn(midi, voice.track)
      voice.started = true
    } catch (error) {
      release(source)
      toast(`Звук не запустился: ${error.message}`)
    }
  }
  function release(source, { tap = true } = {}) {
    const voice = held.get(source)
    if (!voice) return
    held.delete(source)
    voice.tap = tap && !voice.started
    if (
      voice.started &&
      ![...held.values()].some(
        (other) =>
          other.midi === voice.midi &&
          other.track === voice.track &&
          other.started
      )
    )
      engine.noteOff(voice.midi, voice.track)
    if (![...held.values()].some((other) => other.midi === voice.midi))
      document
        .querySelectorAll(`[data-midi="${voice.midi}"]`)
        .forEach((key) => key.classList.remove('sounding'))
  }
  function releaseHeld() {
    for (const source of [...held.keys()]) release(source, { tap: false })
    engine.releaseManual()
  }

  function drawKeyboard() {
    const whites = Array.from({ length: 25 }, (_, i) => i + 60).filter(
      (midi) => !midiToNote(midi).includes('#')
    )
    $('keyboard').innerHTML =
      whites
        .map(
          (midi, i) =>
            `<button class="piano-key white-key" data-midi="${midi}" style="left:${(i / whites.length) * 100}%;width:${100 / whites.length}%" aria-label="Сыграть ${midiToNote(midi)}"><span>${midiToNote(midi)}</span><kbd>${keyLabels[midi] || ''}</kbd></button>`
        )
        .join('') +
      Array.from({ length: 25 }, (_, i) => i + 60)
        .filter((midi) => midiToNote(midi).includes('#'))
        .map((midi) => {
          const index = whites.filter((white) => white < midi).length
          return `<button class="piano-key black-key" data-midi="${midi}" style="left:${(index / whites.length) * 100}%;width:${62 / whites.length}%" aria-label="Сыграть ${midiToNote(midi)}"><kbd>${keyLabels[midi] || ''}</kbd></button>`
        })
        .join('')
    $('pitch-labels').innerHTML =
      `<div class="pitch-ruler">НОТА</div>` +
      Array.from({ length: 25 }, (_, i) => MAX_MIDI - i)
        .map(
          (midi) =>
            `<button class="pitch-label ${midiToNote(midi).includes('#') ? 'sharp' : ''}" data-midi="${midi}" aria-label="Прослушать ${midiToNote(midi)}">${midiToNote(midi)}</button>`
        )
        .join('')
  }
  function rollPosition(event) {
    const rect = $('roll').getBoundingClientRect()
    return {
      tick: clamp(
        ((event.clientX - rect.left) / rect.width) * lengthTicks(project),
        0,
        lengthTicks(project) - 1
      ),
      midi: clamp(
        MAX_MIDI - Math.floor((event.clientY - rect.top) / ROW_HEIGHT),
        MIN_MIDI,
        MAX_MIDI
      )
    }
  }
  $('roll').addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    $('roll').focus({ preventScroll: true })
    const position = rollPosition(event)
    const group = event.target.closest('[data-note-id]')
    if (!group) {
      if (project.tracks[activeTrack].notes.length >= 512) {
        toast('В партии уже 512 нот. Удалите лишние или очистите партию.')
        return
      }
      const step = gridStep(project)
      const start = Math.floor(position.tick / step) * step
      const next = addNote(project, activeTrack, {
        midi: position.midi,
        start,
        duration:
          newDuration === 'grid' ? gridStep(project) : Number(newDuration),
        velocity: 0.7
      })
      selectedId = next.tracks[activeTrack].notes.find(
        (note) => note.midi === position.midi && note.start === start
      )?.id
      commit(next)
      preview(position.midi)
      return
    }
    selectedId = group.dataset.noteId
    const note = selectedNote()
    drag = {
      id: selectedId,
      note: { ...note },
      startX: event.clientX,
      startY: event.clientY,
      mode: event.target.hasAttribute('data-resize') ? 'resize' : 'move',
      patch: {},
      moved: false,
      pointerId: event.pointerId
    }
    $('roll').setPointerCapture(event.pointerId)
    renderControls()
    document
      .querySelectorAll('.roll-note')
      .forEach((element) =>
        element.classList.toggle(
          'selected',
          element.dataset.noteId === selectedId
        )
      )
  })
  $('roll').addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const delta =
      ((event.clientX - drag.startX) / rollWidth) * lengthTicks(project)
    if (
      Math.abs(event.clientX - drag.startX) +
        Math.abs(event.clientY - drag.startY) >
      4
    )
      drag.moved = true
    if (!drag.moved) return
    if (drag.mode === 'resize') {
      drag.patch = {
        duration: clamp(
          snapTick(drag.note.duration + delta, project.grid),
          gridStep(project),
          lengthTicks(project) - drag.note.start
        )
      }
    } else {
      const maxStart =
        Math.floor(
          (lengthTicks(project) - drag.note.duration) / gridStep(project)
        ) * gridStep(project)
      const start = clamp(
        snapTick(drag.note.start + delta, project.grid),
        0,
        maxStart
      )
      drag.patch = {
        start,
        midi: clamp(
          drag.note.midi -
            Math.round((event.clientY - drag.startY) / ROW_HEIGHT),
          MIN_MIDI,
          MAX_MIDI
        )
      }
    }
    const note = { ...drag.note, ...drag.patch }
    const group = document.querySelector(`[data-note-id="${drag.id}"]`)
    const x = (note.start / lengthTicks(project)) * rollWidth + 1
    const y = (MAX_MIDI - note.midi) * ROW_HEIGHT + 2
    const width = Math.max(
      3,
      (note.duration / lengthTicks(project)) * rollWidth - 2
    )
    const rects = group.querySelectorAll('rect')
    rects[0].setAttribute('x', x)
    rects[0].setAttribute('y', y)
    rects[0].setAttribute('width', width)
    rects[1].setAttribute('x', x + Math.max(0, width - 7))
    rects[1].setAttribute('y', y)
    const text = group.querySelector('text')
    if (text) {
      text.setAttribute('x', x + 5)
      text.setAttribute('y', y + Math.min(10, ROW_HEIGHT - 4))
      text.textContent = midiToNote(note.midi)
    }
  })
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const finished = drag
    drag = null
    if (event.type === 'pointercancel') {
      renderRoll()
      return
    }
    if (finished.moved)
      commit(updateNote(project, activeTrack, finished.id, finished.patch))
    else preview(finished.note.midi)
    renderRoll()
  }
  $('roll').addEventListener('pointerup', finishDrag)
  $('roll').addEventListener('pointercancel', finishDrag)
  $('roll').addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const note = event.target.closest('[data-note-id]')
    if (note) {
      commit(removeNote(project, activeTrack, note.dataset.noteId))
      selectedId = null
      renderControls()
    }
  })
  function deleteSelected() {
    if (selectedNote()) {
      commit(removeNote(project, activeTrack, selectedId))
      selectedId = null
      renderControls()
    }
  }

  $('play').addEventListener('click', play)
  $('stop').addEventListener('click', () => {
    audioIntent++
    engine.stop()
    releaseHeld()
    renderTransport()
    renderForest()
  })
  $('loop').addEventListener('click', () => changeField('loop', !project.loop))
  function bindFieldCommit(id, handler) {
    const field = $(id)
    let edited = false
    field.addEventListener('input', () => {
      edited = true
    })
    function finishEdit(event) {
      if (!edited && event.type !== 'change') return
      edited = false
      handler(event)
    }
    field.addEventListener('change', finishEdit)
    field.addEventListener('blur', finishEdit)
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      finishEdit(event)
      field.blur()
    })
  }
  function commitBpm(event) {
    const bpm = Number(event.target.value)
    if (event.target.value.trim() && Number.isFinite(bpm))
      changeField('bpm', clamp(Math.round(bpm), 40, 180))
    renderControls()
  }
  bindFieldCommit('bpm', commitBpm)
  $('bars').addEventListener('change', (event) => {
    const bars = Number(event.target.value)
    const shrinking = bars < project.bars
    commit(resizeProject(project, bars), { stop: true })
    if (shrinking)
      toast('Цикл сокращён. «Отменить» вернёт ноты за его границей.')
  })
  $('grid').addEventListener('change', (event) =>
    changeField('grid', Number(event.target.value))
  )
  $('new-duration').addEventListener('change', (event) => {
    newDuration = event.target.value
  })
  $('metronome').addEventListener('change', (event) =>
    changeField('metronome', event.target.checked)
  )
  $('volume').addEventListener('input', (event) => {
    project.volume = Number(event.target.value)
    engine.setVolume(project.volume)
    $('volume-value').value = `${Math.round(project.volume * 100)}%`
    persist()
  })
  function commitName(event) {
    const name = event.target.value.trim()
    if (name) changeField('name', name)
    else renderControls()
  }
  bindFieldCommit('project-name', commitName)
  $('chords').addEventListener('change', (event) => {
    const next = cloneProject(project)
    next.chords[Number(event.target.dataset.bar)] = event.target.value
    commit(next)
  })
  document.querySelectorAll('[data-track]').forEach((button) =>
    button.addEventListener('click', () => {
      releaseHeld()
      activeTrack = button.dataset.track
      selectedId = null
      if (activeTrack === 'tree') {
        rightMode = 'notes'
        leftMode = 'chords'
      } else {
        rightMode = 'tree'
        leftMode = 'notes'
      }
      render()
    })
  )
  $('chords-tab').addEventListener('click', () => {
    leftMode = 'chords'
    render()
  })
  $('tree-view-tab').addEventListener('click', () => {
    releaseHeld()
    rightMode = 'tree'
    leftMode = 'notes'
    activeTrack = 'piano'
    selectedId = null
    render()
  })
  document.querySelectorAll('[data-workspace-voice]').forEach((button) =>
    button.addEventListener('click', () => {
      const voice = button.dataset.workspaceVoice
      $('workspace').dataset.voice = voice
      document
        .querySelectorAll('[data-workspace-voice]')
        .forEach((tab) =>
          tab.setAttribute(
            'aria-pressed',
            String(tab.dataset.workspaceVoice === voice)
          )
        )
      renderRoll()
    })
  )
  $('mute').addEventListener('click', () => {
    const next = cloneProject(project)
    next.tracks[activeTrack].muted = !next.tracks[activeTrack].muted
    commit(next)
  })
  $('clear').addEventListener('click', () => {
    selectedId = null
    commit(clearTrack(project, activeTrack))
    toast('Партия очищена. Изменение можно отменить.')
  })
  $('undo').addEventListener('click', undo)
  $('redo').addEventListener('click', redo)
  $('delete-note').addEventListener('click', deleteSelected)
  function commitNoteDuration(event) {
    const value = Number(event.target.value)
    if (selectedNote() && Number.isFinite(value))
      commit(updateNote(project, activeTrack, selectedId, { duration: value }))
  }
  bindFieldCommit('note-duration', commitNoteDuration)
  function commitNoteVelocity(event) {
    if (selectedNote())
      commit(
        updateNote(project, activeTrack, selectedId, {
          velocity: Number(event.target.value)
        })
      )
  }
  bindFieldCommit('note-velocity', commitNoteVelocity)
  $('demo').addEventListener('click', () => {
    releaseHeld()
    selectedId = null
    commit(createDemoProject(), { stop: true })
    toast(
      'Исходный эскиз восстановлен. Ваши изменения доступны через «Отменить».'
    )
  })
  $('export').addEventListener('click', () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'vimuzyka.json'
    link.hidden = true
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    toast('JSON отправлен на скачивание.')
  })
  $('import').addEventListener('click', () => $('file-input').click())
  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      if (file.size > 1024 * 1024)
        throw new Error('Файл должен быть меньше 1 МБ')
      const imported = normalizeProject(JSON.parse(await file.text()))
      releaseHeld()
      selectedId = null
      commit(imported, { stop: true })
      toast('Проект открыт.')
    } catch (error) {
      toast(`Не удалось открыть проект: ${error.message}`)
    } finally {
      event.target.value = ''
    }
  })

  drawKeyboard()
  $('keyboard').addEventListener('pointerdown', (event) => {
    const key = event.target.closest('[data-midi]')
    if (!key || event.button !== 0) return
    event.preventDefault()
    key.setPointerCapture(event.pointerId)
    hold(Number(key.dataset.midi), `pointer-${event.pointerId}`)
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    $('keyboard').addEventListener(type, (event) =>
      release(`pointer-${event.pointerId}`, { tap: type === 'pointerup' })
    )
  $('keyboard').addEventListener('click', (event) => {
    if (event.detail === 0) {
      const key = event.target.closest('[data-midi]')
      if (key) preview(Number(key.dataset.midi))
    }
  })
  $('pitch-labels').addEventListener('click', (event) => {
    const key = event.target.closest('[data-midi]')
    if (key) preview(Number(key.dataset.midi))
  })
  function editingInput(event) {
    return !!event.target.closest(
      'input,select,textarea,[contenteditable="true"]'
    )
  }
  document.addEventListener('keydown', (event) => {
    if (editingInput(event)) return
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyY') {
      event.preventDefault()
      redo()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (Object.hasOwn(keyMap, event.code)) {
      event.preventDefault()
      if (!event.repeat) hold(keyMap[event.code], event.code)
    } else if (
      event.code === 'Space' &&
      event.target.tagName !== 'BUTTON' &&
      !event.target.closest('#forest-studio')
    ) {
      event.preventDefault()
      if (!event.repeat) play()
    } else if (
      ['Delete', 'Backspace'].includes(event.key) &&
      event.target === $('roll')
    ) {
      event.preventDefault()
      deleteSelected()
    }
  })
  document.addEventListener('keyup', (event) => release(event.code))
  window.addEventListener('blur', releaseHeld)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      audioIntent++
      releaseHeld()
      if (engine.state === 'playing') engine.pause()
      else if (engine.forestAudition) engine.stop()
      renderTransport()
      renderForest()
    }
  })
  let resizeTimer
  new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (!drag) renderRoll()
    }, 80)
  }).observe($('roll-shell'))
  function animate() {
    const tick = engine.getTick()
    if (playhead) {
      const x = (tick / lengthTicks(project)) * rollWidth
      playhead.setAttribute('x1', x)
      playhead.setAttribute('x2', x)
      playhead.style.opacity =
        tick || engine.state === 'playing' || engine.state === 'paused' ? 1 : 0
    }
    const displayedTick = Math.min(tick, lengthTicks(project) - 0.001)
    $('position').textContent =
      `${String(Math.floor(displayedTick / TICKS_PER_BAR) + 1).padStart(2, '0')} : ${(Math.floor(displayedTick / TICKS_PER_BEAT) % 4) + 1}`
    $('meter').style.height = `${clamp(engine.meter || 0, 0, 1) * 100}%`
    document
      .querySelectorAll('.chord-row')
      .forEach((row, index) =>
        row.classList.toggle(
          'current',
          engine.state === 'playing' && index === Math.floor(tick / 32)
        )
      )
    renderForest()
    requestAnimationFrame(animate)
  }
  engine.setCallbacks({
    onNote: flashNote,
    onBranch: ({ branchId }) => forestView.flash(branchId)
  })
  engine.updateProject(project)
  render()
  persist()
  animate()
  if (restored) toast('Продолжаем с сохранённого в браузере проекта.')
}
