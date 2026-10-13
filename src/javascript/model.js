import { createDefaultForest, normalizeForest } from './forest-model.js'

export const TICKS_PER_BEAT = 8
export const TICKS_PER_BAR = 32
export const MIN_MIDI = 60
export const MAX_MIDI = 84

export const CHORDS = Object.freeze(
  Object.fromEntries(
    [
      ['dm9', 'Dm9', ['D3', 'F3', 'A3', 'C4', 'E4']],
      ['bbmaj7', 'B♭maj7', ['Bb2', 'F3', 'A3', 'D4']],
      ['gm9', 'Gm9', ['G2', 'Bb3', 'D4', 'F4', 'A4']],
      ['asus4', 'Asus4', ['A2', 'E3', 'A3', 'D4']],
      ['am', 'Am', ['A2', 'E3', 'A3', 'C4']],
      ['cmaj7', 'Cmaj7', ['C3', 'G3', 'B3', 'E4']],
      ['fmaj7', 'Fmaj7', ['F2', 'C3', 'E3', 'A3']],
      ['rest', 'Пауза', []]
    ].map(([id, label, notes]) => [
      id,
      Object.freeze({ label, notes: Object.freeze(notes) })
    ])
  )
)

export const TRACKS = Object.freeze({
  piano: Object.freeze({ label: 'Пиано', color: '#dcc99d' }),
  tree: Object.freeze({ label: 'Ветви', color: '#94b8a5' })
})

const GRID_VALUES = [4, 8, 16, 32]
const ROOT_KEYS = [
  'version',
  'name',
  'bpm',
  'bars',
  'grid',
  'loop',
  'volume',
  'metronome',
  'chords',
  'tracks'
]
const NOTE_KEYS = ['id', 'midi', 'start', 'duration', 'velocity']
const EDIT_KEYS = ['midi', 'start', 'duration', 'velocity']
const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B'
]
let nextNoteId = 1

function fail(message) {
  throw new Error(message)
}

function object(value, label, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}: ожидается объект`)
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null)
    fail(`${label}: недопустимый прототип`)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key))
      fail(`${label}: неизвестное поле ${String(key)}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      fail(`${label}: недопустимое поле ${key}`)
  }
  return value
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(`${label}: ожидается конечное число`)
  return value
}

function integer(value, min, max, label) {
  finite(value, label)
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label}: ожидается целое число от ${min} до ${max}`)
  }
  return value
}

function numberInRange(value, min, max, label) {
  finite(value, label)
  if (value < min || value > max)
    fail(`${label}: значение вне диапазона ${min}–${max}`)
  return value
}

function boolean(value, label) {
  if (typeof value !== 'boolean')
    fail(`${label}: ожидается логическое значение`)
  return value
}

function gridValue(grid) {
  if (!GRID_VALUES.includes(grid))
    fail('Сетка: допустимы 4, 8, 16 или 32 деления на такт')
  return grid
}

function trackValue(track) {
  if (!Object.hasOwn(TRACKS, track))
    fail(`Неизвестная партия: ${String(track)}`)
  return track
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function midiToNote(midi) {
  integer(midi, 0, 127, 'MIDI')
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

export function noteToMidi(name) {
  if (typeof name !== 'string') fail('Нота: ожидается строка')
  const match = /^([A-Ga-g])([#b]?)(-?\d{1,2})$/.exec(name)
  if (!match) fail(`Недопустимая нота: ${name}`)
  const pitch = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[
    match[1].toUpperCase()
  ]
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0
  const midi = (Number(match[3]) + 1) * 12 + pitch + accidental
  return integer(midi, 0, 127, 'MIDI')
}

export function lengthTicks(project) {
  return integer(project.bars, 1, 8, 'Количество тактов') * TICKS_PER_BAR
}

export function gridStep(project) {
  return TICKS_PER_BAR / gridValue(project.grid)
}

export function snapTick(tick, grid) {
  finite(tick, 'Позиция')
  const step = TICKS_PER_BAR / gridValue(grid)
  return Math.max(0, Math.round(tick / step) * step)
}

export function normalizeProject(raw) {
  object(raw, 'Проект', [...ROOT_KEYS, 'forest'])
  if (raw.version !== 1 && raw.version !== 2)
    fail('Поддерживаются форматы проекта версий 1 и 2')
  object(
    raw,
    'Проект',
    raw.version === 1 ? ROOT_KEYS : [...ROOT_KEYS, 'forest']
  )
  const forest =
    raw.version === 1 ? createDefaultForest() : normalizeForest(raw.forest)
  if (
    typeof raw.name !== 'string' ||
    !raw.name.trim() ||
    raw.name.length > 160
  ) {
    fail('Название: ожидается непустая строка длиной до 160 символов')
  }
  const bars = integer(raw.bars, 1, 8, 'Количество тактов')
  const total = bars * TICKS_PER_BAR
  const bpm = numberInRange(raw.bpm, 40, 180, 'Темп')
  const grid = gridValue(raw.grid)
  const volume = numberInRange(raw.volume, 0, 1, 'Громкость')
  const loop = boolean(raw.loop, 'Повтор')
  const metronome = boolean(raw.metronome, 'Метроном')
  if (!Array.isArray(raw.chords) || raw.chords.length !== bars) {
    fail('Аккорды: требуется ровно один аккорд на такт')
  }
  const chords = Array.from(raw.chords, (chord) => {
    if (typeof chord !== 'string' || !Object.hasOwn(CHORDS, chord))
      fail(`Неизвестный аккорд: ${String(chord)}`)
    return chord
  })
  object(raw.tracks, 'Партии', Object.keys(TRACKS))
  const tracks = {}
  const ids = new Set()
  for (const trackId of Object.keys(TRACKS)) {
    const rawTrack = object(raw.tracks[trackId], `Партия ${trackId}`, [
      'muted',
      'notes'
    ])
    const muted = boolean(rawTrack.muted, `Партия ${trackId}: выключение`)
    if (!Array.isArray(rawTrack.notes) || rawTrack.notes.length > 512) {
      fail(`Партия ${trackId}: допустимо не более 512 нот`)
    }
    const positions = new Set()
    const notes = Array.from(rawTrack.notes, (rawNote) => {
      object(rawNote, 'Нота', NOTE_KEYS)
      if (
        typeof rawNote.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(rawNote.id) ||
        ids.has(rawNote.id)
      ) {
        fail('Нота: недопустимый или повторяющийся идентификатор')
      }
      ids.add(rawNote.id)
      const midi = integer(rawNote.midi, MIN_MIDI, MAX_MIDI, 'Высота ноты')
      const start = integer(rawNote.start, 0, total - 1, 'Начало ноты')
      const duration = integer(
        rawNote.duration,
        1,
        total - start,
        'Длительность ноты'
      )
      const velocity = numberInRange(rawNote.velocity, 0, 1, 'Сила ноты')
      const position = `${midi}:${start}`
      if (positions.has(position))
        fail(`Партия ${trackId}: две одинаковые ноты в одной позиции`)
      positions.add(position)
      return { id: rawNote.id, midi, start, duration, velocity }
    })
    tracks[trackId] = {
      muted,
      notes: notes.sort((a, b) => a.start - b.start || a.midi - b.midi)
    }
  }
  return {
    version: 2,
    name: raw.name,
    bpm,
    bars,
    grid,
    loop,
    volume,
    metronome,
    chords,
    tracks,
    forest
  }
}

export function cloneProject(project) {
  return normalizeProject(project)
}

export function createDemoProject() {
  const piano = [
    [0, 'A4', 6, 0.64],
    [8, 'F4', 4, 0.56],
    [14, 'E4', 2, 0.43],
    [16, 'D4', 10, 0.62],
    [28, 'E4', 3, 0.42],
    [32, 'F4', 6, 0.58],
    [40, 'A4', 4, 0.62],
    [46, 'G4', 2, 0.42],
    [48, 'F4', 8, 0.55],
    [60, 'D4', 3, 0.4],
    [64, 'D4', 6, 0.57],
    [72, 'F4', 4, 0.6],
    [78, 'A4', 2, 0.46],
    [80, 'G4', 10, 0.61],
    [92, 'F4', 3, 0.4],
    [96, 'E4', 6, 0.53],
    [104, 'D4', 4, 0.5],
    [112, 'C4', 6, 0.45],
    [120, 'D4', 8, 0.48]
  ]
  const tree = [
    [6, 'E5', 8, 0.31],
    [22, 'A5', 10, 0.27],
    [38, 'D5', 8, 0.3],
    [54, 'A5', 10, 0.25],
    [70, 'F5', 8, 0.31],
    [86, 'A5', 10, 0.28],
    [102, 'E5', 8, 0.26],
    [118, 'D5', 10, 0.22]
  ]
  return normalizeProject({
    version: 2,
    forest: createDefaultForest(),
    name: 'Сигнал в тумане',
    bpm: 72,
    bars: 4,
    grid: 16,
    loop: true,
    volume: 0.65,
    metronome: false,
    chords: ['dm9', 'bbmaj7', 'gm9', 'asus4'],
    tracks: {
      piano: {
        muted: false,
        notes: piano.map(([start, note, duration, velocity], index) => ({
          id: `p-${index + 1}`,
          midi: noteToMidi(note),
          start,
          duration,
          velocity
        }))
      },
      tree: {
        muted: false,
        notes: tree.map(([start, note, duration, velocity], index) => ({
          id: `t-${index + 1}`,
          midi: noteToMidi(note),
          start,
          duration,
          velocity
        }))
      }
    }
  })
}

export function resizeProject(project, bars) {
  const result = cloneProject(project)
  result.bars = clamp(Math.round(finite(bars, 'Количество тактов')), 1, 8)
  const total = lengthTicks(result)
  result.chords = result.chords.slice(0, result.bars)
  while (result.chords.length < result.bars) result.chords.push('rest')
  for (const track of Object.values(result.tracks)) {
    track.notes = track.notes
      .filter((note) => note.start < total)
      .map((note) => ({
        ...note,
        duration: Math.min(note.duration, total - note.start)
      }))
  }
  return result
}

function editableNote(note, total) {
  const midi = clamp(
    Math.round(finite(note.midi, 'Высота ноты')),
    MIN_MIDI,
    MAX_MIDI
  )
  const start = clamp(
    Math.round(finite(note.start, 'Начало ноты')),
    0,
    total - 1
  )
  const duration = clamp(
    Math.round(finite(note.duration, 'Длительность ноты')),
    1,
    total - start
  )
  const velocity = clamp(finite(note.velocity, 'Сила ноты'), 0, 1)
  return { midi, start, duration, velocity }
}

function uniqueId(project) {
  const ids = new Set(
    Object.values(project.tracks).flatMap((track) =>
      track.notes.map((note) => note.id)
    )
  )
  let id
  do {
    id = `n-${nextNoteId++}`
  } while (ids.has(id))
  return id
}

export function addNote(project, track, note) {
  trackValue(track)
  object(note, 'Новая нота', EDIT_KEYS)
  const result = cloneProject(project)
  const notes = result.tracks[track].notes
  const values = editableNote(
    {
      ...note,
      duration: note.duration ?? gridStep(result),
      velocity: note.velocity ?? 0.7
    },
    lengthTicks(result)
  )
  if (
    notes.some(
      (existing) =>
        existing.midi === values.midi && existing.start === values.start
    )
  )
    return result
  if (notes.length >= 512) fail('В партии уже 512 нот')
  notes.push({ id: uniqueId(result), ...values })
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi)
  return result
}

export function removeNote(project, track, id) {
  trackValue(track)
  const result = cloneProject(project)
  result.tracks[track].notes = result.tracks[track].notes.filter(
    (note) => note.id !== id
  )
  return result
}

export function updateNote(project, track, id, patch) {
  trackValue(track)
  object(patch, 'Изменение ноты', EDIT_KEYS)
  const result = cloneProject(project)
  const notes = result.tracks[track].notes
  const index = notes.findIndex((note) => note.id === id)
  if (index === -1) return result
  const values = editableNote(
    { ...notes[index], ...patch },
    lengthTicks(result)
  )
  if (
    notes.some(
      (note, candidate) =>
        candidate !== index &&
        note.midi === values.midi &&
        note.start === values.start
    )
  )
    return result
  notes[index] = { id, ...values }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi)
  return result
}

export function clearTrack(project, track) {
  trackValue(track)
  const result = cloneProject(project)
  result.tracks[track].notes = []
  return result
}
