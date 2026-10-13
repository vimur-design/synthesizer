export const SCALES = Object.freeze({
  minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
  pentatonic: Object.freeze([0, 3, 5, 7, 10]),
  chromatic: Object.freeze(Array.from({ length: 12 }, (_, i) => i)),
  free: null
})

const range = (min, max, step) => Object.freeze({ min, max, step })
export const FOREST_RANGES = Object.freeze({
  density: range(0.15, 1, 0.01),
  height: range(0.35, 1, 0.01),
  width: range(0.25, 1, 0.01),
  x: range(0.08, 0.92, 0.01),
  seed: range(0, 4294967295, 1),
  tuning: range(24, 96, 1),
  spread: range(0, 48, 1),
  tonic: range(0, 11, 1),
  shift: range(-24, 24, 1),
  inharmonic: range(0, 1, 0.01),
  decay: range(0.1, 8, 0.1),
  algorithm: range(0, 1, 0.01),
  noise: range(0, 1, 0.01),
  thru: range(0, 1, 0.01),
  filter: range(120, 16000, 10),
  bandwidth: range(0.2, 8, 0.1),
  wind: range(0, 1, 0.01),
  windSpeed: range(0.03, 3, 0.01),
  rain: range(0, 1, 0.01),
  rainSpeed: range(0.1, 12, 0.1),
  rainCenter: range(0, 1, 0.01),
  rainSpread: range(0, 1, 0.01),
  lowCut: range(20, 4000, 10),
  highCut: range(100, 20000, 10),
  pan: range(-1, 1, 0.01),
  gain: range(0, 1, 0.01)
})

const TREE_KEYS = [
  'id',
  'seed',
  'shape',
  'density',
  'height',
  'width',
  'x',
  'enabled'
]
const PARAM_KEYS = [
  'tuning',
  'spread',
  'scale',
  'tonic',
  'shift',
  'inharmonic',
  'decay',
  'algorithm',
  'noise',
  'thru',
  'filter',
  'bandwidth',
  'pink',
  'wind',
  'windSpeed',
  'rain',
  'rainSpeed',
  'rainCenter',
  'rainSpread',
  'lowCut',
  'highCut',
  'pan',
  'gain'
]

export function createDefaultForest() {
  return {
    version: 1,
    trees: [
      {
        id: 'tree-1',
        seed: 20261006,
        shape: 'round',
        density: 0.55,
        height: 0.8,
        width: 0.75,
        x: 0.5,
        enabled: true
      }
    ],
    tuning: 60,
    spread: 24,
    scale: 'minor',
    tonic: 2,
    shift: 0,
    inharmonic: 0.15,
    decay: 2.4,
    algorithm: 0.35,
    noise: 0.08,
    thru: 0,
    filter: 2400,
    bandwidth: 2,
    pink: true,
    wind: 0.3,
    windSpeed: 0.3,
    rain: 0.22,
    rainSpeed: 2,
    rainCenter: 0.5,
    rainSpread: 1,
    lowCut: 180,
    highCut: 7000,
    pan: 0,
    gain: 0.65
  }
}

function fail(message) {
  throw new Error(message)
}
function plainObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label}: ожидается объект`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label}: недопустимый прототип`)
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length)
    fail(`${label}: неполный формат или неизвестные поля`)
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key))
      fail(`${label}: неизвестное поле ${String(key)}`)
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
      fail(`${label}: недопустимый accessor`)
  }
}

function safeArray(value, max, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > max
  ) {
    fail(`${label}: требуется от 1 до ${max} элементов`)
  }
  if (Reflect.ownKeys(value).length !== value.length + 1)
    fail(`${label}: неплотный или расширенный массив`)
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      fail(`${label}: недопустимый элемент`)
  }
}

function validateNumber(value, key) {
  const { min, max } = FOREST_RANGES[key]
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    fail(`Дерево: ${key} должно быть числом от ${min} до ${max}`)
  }
  if (['seed', 'tonic', 'shift'].includes(key) && !Number.isInteger(value))
    fail(`Дерево: ${key} должно быть целым`)
  return value
}

export function normalizeForest(raw) {
  plainObject(raw, ['version', 'trees', ...PARAM_KEYS], 'Лес')
  if (raw.version !== 1) fail('Поддерживается только версия леса 1')
  safeArray(raw.trees, 3, 'Деревья')
  const ids = new Set()
  const trees = raw.trees.map((tree) => {
    plainObject(tree, TREE_KEYS, 'Дерево')
    if (
      typeof tree.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(tree.id) ||
      ids.has(tree.id)
    )
      fail('Дерево: недопустимый или повторяющийся id')
    ids.add(tree.id)
    if (!['round', 'cone', 'fan'].includes(tree.shape))
      fail('Дерево: неизвестная форма кроны')
    if (typeof tree.enabled !== 'boolean')
      fail('Дерево: enabled должно быть логическим')
    return {
      id: tree.id,
      seed: validateNumber(tree.seed, 'seed'),
      shape: tree.shape,
      density: validateNumber(tree.density, 'density'),
      height: validateNumber(tree.height, 'height'),
      width: validateNumber(tree.width, 'width'),
      x: validateNumber(tree.x, 'x'),
      enabled: tree.enabled
    }
  })
  if (typeof raw.scale !== 'string' || !Object.hasOwn(SCALES, raw.scale))
    fail('Лес: неизвестный лад')
  if (typeof raw.pink !== 'boolean') fail('Лес: pink должно быть логическим')
  const result = { version: 1, trees }
  for (const key of PARAM_KEYS)
    result[key] =
      key === 'scale' || key === 'pink'
        ? raw[key]
        : validateNumber(raw[key], key)
  if (result.lowCut >= result.highCut)
    fail('Лес: lowCut должен быть ниже highCut')
  return result
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

function hash(value) {
  let h = 2166136261
  for (const char of String(value)) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function randomGenerator(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function attractorsFor(tree, random) {
  const height = 0.8 * tree.height
  const radius = 0.3 * tree.width
  const top = 0.93 - height
  return Array.from({ length: 24 + Math.round(tree.density * 100) }, () => {
    let x, y
    if (tree.shape === 'round') {
      const theta = random() * Math.PI * 2
      const r = Math.sqrt(random())
      x = tree.x + radius * r * Math.cos(theta)
      y = 0.93 - height * 0.66 + height * 0.38 * r * Math.sin(theta)
    } else if (tree.shape === 'cone') {
      const t = Math.sqrt(random())
      x = tree.x + radius * t * (random() * 2 - 1)
      y = top + height * 0.72 * t
    } else {
      const theta = Math.PI * (0.16 + random() * 0.68)
      const r = 0.55 + random() * 0.45
      x = tree.x + radius * 1.3 * Math.cos(theta) * r
      y = 0.93 - height * 0.17 - height * 0.82 * Math.sin(theta) * r
    }
    return { x: clamp(x, 0.035, 0.965), y: clamp(y, 0.035, 0.92) }
  })
}

function colonize(tree) {
  const random = randomGenerator(tree.seed ^ hash(tree.id))
  let points = attractorsFor(tree, random)
  const maxBranches = Math.min(48, 12 + Math.round(tree.density * 36))
  const step = 0.8 * tree.height * 0.08
  const influenceRadius = step * 4.5
  const killRadius = step * 0.85
  const nodes = [{ id: null, x: tree.x, y: 0.93, parent: -1, children: [] }]

  function append(parent, dx, dy) {
    const magnitude = Math.hypot(dx, dy)
    if (magnitude < 1e-9 || nodes.length > maxBranches) return false
    const source = nodes[parent]
    const x = clamp(source.x + (dx / magnitude) * step, 0.025, 0.975)
    const y = clamp(source.y + (dy / magnitude) * step, 0.025, 0.94)
    if (Math.hypot(x - source.x, y - source.y) < step * 0.45) return false
    if (
      source.children.some(
        (i) => Math.hypot(nodes[i].x - x, nodes[i].y - y) < step * 0.55
      )
    )
      return false
    const index = nodes.length
    nodes.push({ id: `${tree.id}-b-${index}`, x, y, parent, children: [] })
    source.children.push(index)
    return true
  }

  for (
    let iteration = 0;
    iteration < 160 && points.length && nodes.length <= maxBranches;
    iteration++
  ) {
    const directions = new Map()
    const remaining = []
    for (const point of points) {
      let nearest = -1
      let closest = influenceRadius
      let reached = false
      for (let i = 0; i < nodes.length; i++) {
        const d = distance(point, nodes[i])
        if (d < killRadius) {
          reached = true
          break
        }
        if (nodes[i].children.length < 3 && d < closest) {
          nearest = i
          closest = d
        }
      }
      if (reached) continue
      remaining.push(point)
      if (nearest >= 0) {
        const vector = directions.get(nearest) ?? { x: 0, y: 0, count: 0 }
        vector.x += (point.x - nodes[nearest].x) / closest
        vector.y += (point.y - nodes[nearest].y) / closest
        vector.count++
        directions.set(nearest, vector)
      }
    }
    points = remaining
    let added = 0
    for (const [parent, vector] of directions) {
      const jitter = (random() - 0.5) * 0.08
      if (
        append(
          parent,
          vector.x / vector.count + jitter,
          vector.y / vector.count - 0.025
        )
      )
        added++
      if (nodes.length > maxBranches) break
    }
    if (!directions.size && points.length) {
      let bestParent = -1,
        bestPoint,
        bestDistance = Infinity
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].children.length) continue
        for (const point of points) {
          const d = distance(nodes[i], point)
          if (d < bestDistance) {
            bestDistance = d
            bestParent = i
            bestPoint = point
          }
        }
      }
      if (
        bestParent >= 0 &&
        append(
          bestParent,
          bestPoint.x - nodes[bestParent].x,
          bestPoint.y - nodes[bestParent].y
        )
      )
        added++
    }
    if (!added) break
  }

  const descendants = Array(nodes.length).fill(1)
  for (let i = nodes.length - 1; i > 0; i--)
    descendants[nodes[i].parent] += descendants[i]
  return nodes.slice(1).map((node, index) => {
    const parent = nodes[node.parent]
    return {
      id: node.id,
      treeId: tree.id,
      parentId: parent.id,
      x1: parent.x,
      y1: parent.y,
      x2: node.x,
      y2: node.y,
      length: distance(node, parent),
      thickness: 0.0028 * Math.sqrt(descendants[index + 1])
    }
  })
}

function quantize(midi, scale, tonic) {
  if (scale === null) return midi
  let result = Math.round(midi),
    best = Infinity
  for (
    let candidate = Math.floor(midi) - 12;
    candidate <= Math.ceil(midi) + 12;
    candidate++
  ) {
    if (!scale.includes((((candidate - tonic) % 12) + 12) % 12)) continue
    const difference = Math.abs(candidate - midi)
    if (difference < best) {
      best = difference
      result = candidate
    }
  }
  return result
}

function shiftDegrees(midi, scale, tonic, shift) {
  const relative = midi - tonic
  const octave = Math.floor(relative / 12)
  const pitch = ((relative % 12) + 12) % 12
  const degree = octave * scale.length + scale.indexOf(pitch) + shift
  const targetOctave = Math.floor(degree / scale.length)
  const targetIndex = ((degree % scale.length) + scale.length) % scale.length
  return tonic + targetOctave * 12 + scale[targetIndex]
}

function resonator(branch, tree, forest) {
  const size =
    Math.pow(branch.length / 0.06, 0.65) *
    Math.pow(branch.thickness / 0.012, 0.25)
  const geometricMidi =
    forest.tuning +
    forest.spread * (0.25 - 0.55 * Math.log2(Math.max(0.1, size)))
  const scale = SCALES[forest.scale]
  const quantizedMidi = quantize(geometricMidi, scale, forest.tonic)
  const shiftedMidi =
    scale === null
      ? geometricMidi + forest.shift
      : shiftDegrees(quantizedMidi, scale, forest.tonic, forest.shift)
  const midi = clamp(
    shiftedMidi +
      (scale === null
        ? 0
        : (geometricMidi - quantizedMidi) * forest.inharmonic),
    24,
    108
  )
  const bodyGain =
    0.16 +
    0.62 *
      clamp(
        (branch.thickness / 0.016) * Math.sqrt(branch.length / 0.06),
        0.1,
        1
      )
  return {
    ...branch,
    midi,
    frequency: 440 * Math.pow(2, (midi - 69) / 12),
    pan: clamp(((branch.x1 + branch.x2) / 2 - 0.5) * 2 + forest.pan, -1, 1),
    gain: tree.enabled ? bodyGain : 0,
    decay: clamp(forest.decay * (0.35 + size * 0.6), 0.1, 12)
  }
}

export function generateForest(raw) {
  const forest = normalizeForest(raw)
  const trees = forest.trees.map((tree) => ({
    ...tree,
    branches: colonize(tree).map((branch) => resonator(branch, tree, forest))
  }))
  return { trees, branches: trees.flatMap((tree) => tree.branches) }
}
