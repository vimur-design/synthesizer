import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TICKS_PER_BEAT,
  TICKS_PER_BAR,
  CHORDS,
  createDemoProject,
  cloneProject,
  normalizeProject,
  lengthTicks,
  gridStep,
  snapTick,
  midiToNote,
  noteToMidi,
  resizeProject,
  addNote,
  removeNote,
  updateNote,
  clearTrack
} from '../src/javascript/model.js'

test('demo is valid, contains four harmonic bars and two musical voices', () => {
  const project = createDemoProject()
  assert.equal(TICKS_PER_BEAT, 8)
  assert.equal(TICKS_PER_BAR, 32)
  assert.equal(lengthTicks(project), 128)
  assert.equal(project.bpm, 72)
  assert.equal(project.chords.length, project.bars)
  assert.ok(project.tracks.piano.notes.length > 8)
  assert.ok(project.tracks.tree.notes.length > 0)
  assert.deepEqual(
    normalizeProject(JSON.parse(JSON.stringify(project))),
    project
  )
  for (const chord of Object.values(CHORDS)) chord.notes.forEach(noteToMidi)
})

test('MIDI conversions are reversible over the full MIDI range and support ASCII accidentals', () => {
  for (let midi = 0; midi <= 127; midi++)
    assert.equal(noteToMidi(midiToNote(midi)), midi)
  assert.equal(noteToMidi('A4'), 69)
  assert.equal(noteToMidi('Bb3'), noteToMidi('A#3'))
  assert.equal(noteToMidi('Cb4'), noteToMidi('B3'))
  assert.equal(noteToMidi('B#3'), noteToMidi('C4'))
  assert.equal(noteToMidi('c4'), 60)
  for (const value of ['До4', 'C♯4', 'H4', 'C4.5', 'C99', 'C#', '', null])
    assert.throws(() => noteToMidi(value))
  for (const value of [-1, 128, 1.5, NaN])
    assert.throws(() => midiToNote(value))
})

test('changing the grid does not move or resize existing notes', () => {
  const project = createDemoProject()
  const originalNotes = structuredClone(project.tracks)
  for (const grid of [4, 8, 16, 32]) {
    project.grid = grid
    const copy = cloneProject(project)
    assert.deepEqual(copy.tracks, originalNotes)
    assert.equal(gridStep(copy), 32 / grid)
  }
  assert.equal(snapTick(11, 16), 12)
  assert.equal(snapTick(11, 32), 11)
  assert.equal(snapTick(-5, 16), 0)
  assert.throws(() => snapTick(NaN, 16))
  assert.throws(() => snapTick(1, 12))
})

test('clone owns all mutable project data', () => {
  const project = createDemoProject()
  const copy = cloneProject(project)
  copy.chords[0] = 'rest'
  copy.tracks.piano.notes[0].start = 1
  copy.tracks.tree.muted = true
  assert.equal(project.chords[0], 'dm9')
  assert.equal(project.tracks.piano.notes[0].start, 0)
  assert.equal(project.tracks.tree.muted, false)
})

test('resize crops notes at loop end, removes later notes, and expands with rests', () => {
  let project = clearTrack(createDemoProject(), 'piano')
  project = addNote(project, 'piano', {
    midi: 60,
    start: 30,
    duration: 10,
    velocity: 0.6
  })
  project = addNote(project, 'piano', {
    midi: 62,
    start: 32,
    duration: 8,
    velocity: 0.6
  })
  const shorter = resizeProject(project, 1)
  assert.deepEqual(
    shorter.tracks.piano.notes.map(({ start, duration }) => [start, duration]),
    [[30, 2]]
  )
  assert.deepEqual(shorter.chords, ['dm9'])
  assert.equal(project.bars, 4)
  assert.equal(project.tracks.piano.notes.length, 2)
  const longer = resizeProject(shorter, 8)
  assert.deepEqual(longer.chords, ['dm9', ...Array(7).fill('rest')])
  assert.equal(longer.tracks.piano.notes[0].duration, 2)
  assert.equal(resizeProject(project, 99).bars, 8)
  assert.equal(resizeProject(project, -2).bars, 1)
  assert.throws(() => resizeProject(project, Infinity))
})

test('editing is immutable, clamps loop boundaries, prevents pitch/start duplicates, and keeps IDs unique', () => {
  const original = clearTrack(createDemoProject(), 'piano')
  let project = addNote(original, 'piano', {
    midi: 59,
    start: -1,
    duration: 500,
    velocity: 2
  })
  assert.equal(original.tracks.piano.notes.length, 0)
  let note = project.tracks.piano.notes[0]
  assert.deepEqual(
    {
      midi: note.midi,
      start: note.start,
      duration: note.duration,
      velocity: note.velocity
    },
    { midi: 60, start: 0, duration: 128, velocity: 1 }
  )
  project = addNote(project, 'piano', { midi: 60, start: 0, duration: 2 })
  assert.equal(project.tracks.piano.notes.length, 1)
  project = addNote(project, 'piano', {
    midi: 84,
    start: 500,
    duration: 12,
    velocity: -0.1
  })
  assert.equal(project.tracks.piano.notes[1].start, 127)
  assert.equal(project.tracks.piano.notes[1].duration, 1)
  assert.equal(project.tracks.piano.notes[1].velocity, 0)
  const ids = Object.values(project.tracks).flatMap((track) =>
    track.notes.map((n) => n.id)
  )
  assert.equal(new Set(ids).size, ids.length)
  const unchanged = updateNote(
    project,
    'piano',
    project.tracks.piano.notes[1].id,
    { midi: 60, start: 0 }
  )
  assert.deepEqual(unchanged, project)
  const moved = updateNote(project, 'piano', note.id, {
    start: 126,
    duration: 8
  })
  note = moved.tracks.piano.notes.find((n) => n.id === note.id)
  assert.equal(note.duration, 2)
  assert.equal(project.tracks.piano.notes[0].start, 0)
  assert.equal(removeNote(moved, 'piano', note.id).tracks.piano.notes.length, 1)
  assert.equal(clearTrack(moved, 'piano').tracks.piano.notes.length, 0)
  assert.equal(
    clearTrack(moved, 'piano').tracks.tree.notes.length,
    moved.tracks.tree.notes.length
  )
})

test('strict import rejects invalid types, ranges, missing data, and unknown chords/tracks', () => {
  const corruptions = [
    (p) => {
      p.version = 3
    },
    (p) => {
      delete p.name
    },
    (p) => {
      p.bpm = NaN
    },
    (p) => {
      p.bpm = 181
    },
    (p) => {
      p.bars = 1.5
    },
    (p) => {
      p.grid = 12
    },
    (p) => {
      p.volume = Infinity
    },
    (p) => {
      p.loop = 'true'
    },
    (p) => {
      p.metronome = 0
    },
    (p) => {
      p.chords.pop()
    },
    (p) => {
      p.chords[0] = 'unknown'
    },
    (p) => {
      p.chords[0] = '__proto__'
    },
    (p) => {
      p.tracks.bass = { muted: false, notes: [] }
    },
    (p) => {
      delete p.tracks.tree
    },
    (p) => {
      p.tracks.piano.muted = 1
    },
    (p) => {
      p.tracks.piano.notes[0].start = -1
    },
    (p) => {
      p.tracks.piano.notes[0].duration = 129
    },
    (p) => {
      p.tracks.piano.notes[0].midi = 85
    },
    (p) => {
      p.tracks.piano.notes[0].velocity = null
    },
    (p) => {
      p.tracks.piano.notes[0].id = '" onclick="evil'
    },
    (p) => {
      p.tracks.piano.notes[0].extra = 1
    }
  ]
  for (const corrupt of corruptions) {
    const project = createDemoProject()
    corrupt(project)
    assert.throws(() => normalizeProject(project))
  }
  for (const value of [null, [], 'project', 1])
    assert.throws(() => normalizeProject(value))
  assert.throws(() =>
    addNote(createDemoProject(), 'bass', { midi: 60, start: 0 })
  )
  assert.throws(() =>
    addNote(createDemoProject(), '__proto__', { midi: 60, start: 0 })
  )
  assert.throws(() =>
    updateNote(createDemoProject(), 'piano', 'p-1', { id: 'changed' })
  )
})

test('strict import rejects duplicate IDs across voices and same pitch/start in one voice', () => {
  let project = createDemoProject()
  project.tracks.tree.notes[0].id = project.tracks.piano.notes[0].id
  assert.throws(() => normalizeProject(project))
  project = createDemoProject()
  project.tracks.piano.notes.push({
    ...project.tracks.piano.notes[0],
    id: 'new-id'
  })
  assert.throws(() => normalizeProject(project))
  project = createDemoProject()
  project.tracks.tree.notes.push({
    ...project.tracks.piano.notes[0],
    id: 'new-id'
  })
  assert.doesNotThrow(() => normalizeProject(project))
})

test('imports reject prototype pollution, accessors, and sparse arrays', () => {
  const project = createDemoProject()
  const polluted = JSON.parse(JSON.stringify(project))
  Object.defineProperty(polluted, '__proto__', {
    enumerable: true,
    value: { polluted: true }
  })
  assert.throws(() => normalizeProject(polluted))
  assert.equal({}.polluted, undefined)
  const inherited = Object.create(project)
  assert.throws(() => normalizeProject(inherited))
  const accessor = createDemoProject()
  Object.defineProperty(accessor, 'bpm', {
    get() {
      throw new Error('getter executed')
    }
  })
  assert.throws(() => normalizeProject(accessor), /недопустимое поле/)
  const sparse = createDemoProject()
  delete sparse.tracks.piano.notes[0]
  assert.throws(() => normalizeProject(sparse))
  const nullPrototype = Object.assign(Object.create(null), project)
  assert.doesNotThrow(() => normalizeProject(nullPrototype))
})

test('note count limit applies to imports and editor additions', () => {
  let project = resizeProject(clearTrack(createDemoProject(), 'piano'), 8)
  project.tracks.piano.notes = Array.from({ length: 512 }, (_, index) => ({
    id: `full-${index}`,
    midi: 60 + Math.floor(index / 256),
    start: index % 256,
    duration: 1,
    velocity: 0.7
  }))
  assert.doesNotThrow(() => normalizeProject(project))
  assert.throws(() => addNote(project, 'piano', { midi: 62, start: 0 }))
  project.tracks.piano.notes.push({
    id: 'over-limit',
    midi: 62,
    start: 0,
    duration: 1,
    velocity: 0.7
  })
  assert.throws(() => normalizeProject(project))
})
