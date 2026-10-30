import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDefaultForest,
  normalizeForest,
  generateForest,
  FOREST_RANGES,
  SCALES
} from '../src/javascript/forest-model.js'
import {
  createDemoProject,
  normalizeProject,
  cloneProject
} from '../src/javascript/model.js'

const geometry = (forest) =>
  generateForest(forest).branches.map(
    ({ id, treeId, parentId, x1, y1, x2, y2, length, thickness }) => ({
      id,
      treeId,
      parentId,
      x1,
      y1,
      x2,
      y2,
      length,
      thickness
    })
  )

test('forest state and generated trees round-trip deterministically without shared references', () => {
  const forest = createDefaultForest()
  const original = structuredClone(forest)
  const restored = normalizeForest(JSON.parse(JSON.stringify(forest)))
  assert.deepEqual(restored, original)
  assert.deepEqual(generateForest(forest), generateForest(restored))
  assert.deepEqual(forest, original)
  restored.trees[0].x = 0.6
  assert.equal(forest.trees[0].x, 0.5)
  assert.notDeepEqual(geometry(restored), geometry(forest))
  const changedSeed = structuredClone(forest)
  changedSeed.trees[0].seed++
  assert.notDeepEqual(geometry(changedSeed), geometry(forest))
})

test('Space Colonization produces a connected, branching tree with accumulated parent thickness', () => {
  const forest = createDefaultForest()
  const { trees, branches } = generateForest(forest)
  assert.equal(trees.length, 1)
  assert.deepEqual(trees[0].branches, branches)
  assert.ok(branches.length > 10 && branches.length <= 48)
  const byId = new Map(branches.map((branch) => [branch.id, branch]))
  assert.equal(byId.size, branches.length)
  assert.equal(branches.filter((branch) => branch.parentId === null).length, 1)
  assert.ok(
    branches.some(
      (branch) =>
        branches.filter((child) => child.parentId === branch.id).length > 1
    )
  )
  for (const branch of branches) {
    for (const coordinate of ['x1', 'y1', 'x2', 'y2'])
      assert.ok(branch[coordinate] >= 0 && branch[coordinate] <= 1)
    assert.ok(branch.length > 0)
    assert.ok(
      Math.abs(
        branch.length - Math.hypot(branch.x2 - branch.x1, branch.y2 - branch.y1)
      ) < 1e-12
    )
    assert.ok(branch.thickness > 0)
    assert.ok(Number.isFinite(branch.frequency) && branch.frequency > 0)
    assert.ok(branch.gain > 0 && branch.gain <= 1)
    assert.ok(branch.decay >= 0.1 && branch.decay <= 12)
    if (branch.parentId !== null) {
      const parent = byId.get(branch.parentId)
      assert.ok(parent)
      assert.equal(branch.x1, parent.x2)
      assert.equal(branch.y1, parent.y2)
      assert.ok(parent.thickness >= branch.thickness)
    }
  }
})

test('shapes and dimensions affect geometry; higher density permits a denser crown', () => {
  const forest = createDefaultForest()
  const baseline = geometry(forest)
  for (const patch of [
    { shape: 'cone' },
    { shape: 'fan' },
    { height: 1 },
    { width: 0.3 }
  ]) {
    const changed = structuredClone(forest)
    Object.assign(changed.trees[0], patch)
    assert.notDeepEqual(geometry(changed), baseline)
  }
  const sparse = structuredClone(forest)
  sparse.trees[0].density = 0.15
  const dense = structuredClone(forest)
  dense.trees[0].density = 1
  assert.ok(
    generateForest(dense).branches.length >
      generateForest(sparse).branches.length
  )
  assert.ok(
    generateForest({ ...forest, trees: [{ ...forest.trees[0], height: 1 }] })
      .branches[0].length > generateForest(forest).branches[0].length
  )
})

test('geometry maps longer/thicker resonators to lower, louder, more sustained notes', () => {
  const forest = createDefaultForest()
  forest.scale = 'free'
  forest.inharmonic = 0
  const branches = generateForest(forest).branches
  const longestBody = [...branches].sort((a, b) => b.thickness - a.thickness)[0]
  const thinTip = [...branches].sort((a, b) => a.thickness - b.thickness)[0]
  assert.ok(longestBody.midi < thinTip.midi)
  assert.ok(longestBody.gain > thinTip.gain)
  assert.ok(longestBody.decay > thinTip.decay)
  const taller = structuredClone(forest)
  taller.trees[0].height = 1
  const tallRoot = generateForest(taller).branches[0]
  assert.ok(tallRoot.length > branches[0].length)
  assert.ok(tallRoot.midi < branches[0].midi)
})

test('tuning, scale, transpose and inharmonicity change sound without changing growth', () => {
  const forest = createDefaultForest()
  forest.inharmonic = 0
  const baselineGeometry = geometry(forest)
  for (const scale of Object.keys(SCALES)) {
    const changed = { ...forest, scale }
    const branches = generateForest(changed).branches
    assert.deepEqual(geometry(changed), baselineGeometry)
    if (scale !== 'free') {
      assert.ok(branches.every((branch) => Number.isInteger(branch.midi)))
      assert.ok(
        branches.every((branch) =>
          SCALES[scale].includes(
            (((branch.midi - forest.tonic) % 12) + 12) % 12
          )
        )
      )
    }
  }
  const baseline = generateForest(forest).branches
  const shifted = generateForest({ ...forest, shift: 7 }).branches
  shifted.forEach((branch, i) => {
    assert.equal(branch.midi, baseline[i].midi + 12)
    assert.ok(Math.abs(branch.frequency / baseline[i].frequency - 2) < 1e-12)
  })
  const retuned = generateForest({ ...forest, tuning: 72 }).branches
  retuned.forEach((branch, i) =>
    assert.equal(branch.midi, baseline[i].midi + 12)
  )
  const nextDegree = generateForest({ ...forest, shift: 1 }).branches
  nextDegree.forEach((branch, i) => {
    const pitch = (((baseline[i].midi - forest.tonic) % 12) + 12) % 12
    const index = SCALES.minor.indexOf(pitch)
    const step =
      (((SCALES.minor[(index + 1) % SCALES.minor.length] - pitch) % 12) + 12) %
      12
    assert.equal(branch.midi, baseline[i].midi + step)
  })
  const inharmonic = generateForest({ ...forest, inharmonic: 1 }).branches
  assert.ok(inharmonic.some((branch) => !Number.isInteger(branch.midi)))
  const free = generateForest({ ...forest, scale: 'free' }).branches
  inharmonic.forEach((branch, i) =>
    assert.ok(Math.abs(branch.midi - free[i].midi) < 1e-12)
  )
  const halfway = generateForest({ ...forest, inharmonic: 0.5 }).branches
  halfway.forEach((branch, i) =>
    assert.ok(
      Math.abs(branch.midi - (baseline[i].midi + free[i].midi) / 2) < 1e-12
    )
  )
  assert.deepEqual(geometry({ ...forest, inharmonic: 1 }), baselineGeometry)
  const longerDecay = generateForest({ ...forest, decay: 4.8 }).branches
  longerDecay.forEach((branch, i) =>
    assert.ok(Math.abs(branch.decay / baseline[i].decay - 2) < 1e-12)
  )
})

test('stereo follows horizontal position and master pan; disabling retains geometry but silences every branch', () => {
  const forest = createDefaultForest()
  const left = structuredClone(forest),
    right = structuredClone(forest)
  left.trees[0].x = 0.3
  right.trees[0].x = 0.7
  const averagePan = (state) =>
    generateForest(state).branches.reduce(
      (sum, branch, _, array) => sum + branch.pan / array.length,
      0
    )
  assert.ok(averagePan(left) < 0)
  assert.ok(averagePan(right) > 0)
  assert.ok(averagePan({ ...forest, pan: 0.5 }) > averagePan(forest))
  const muted = structuredClone(forest)
  muted.trees[0].enabled = false
  assert.deepEqual(geometry(muted), geometry(forest))
  assert.ok(generateForest(muted).branches.every((branch) => branch.gain === 0))
  assert.ok(
    generateForest({ ...forest, pan: 1 }).branches.every(
      (branch) => branch.pan >= -1 && branch.pan <= 1
    )
  )
  // The shared master gain belongs to the audio output; per-body gain is stable.
  assert.deepEqual(
    generateForest({ ...forest, gain: 0 }).branches,
    generateForest(forest).branches
  )
})

test('three-tree forest stays bounded across shapes and extreme geometry settings', () => {
  for (const height of [FOREST_RANGES.height.min, FOREST_RANGES.height.max]) {
    for (const width of [FOREST_RANGES.width.min, FOREST_RANGES.width.max]) {
      const forest = createDefaultForest()
      forest.trees = ['round', 'cone', 'fan'].map((shape, i) => ({
        ...forest.trees[0],
        id: `tree-${i + 1}`,
        seed: i,
        shape,
        density: 1,
        height,
        width,
        x: [0.08, 0.5, 0.92][i]
      }))
      const result = generateForest(forest)
      assert.ok(result.branches.length <= 144)
      assert.equal(
        new Set(result.branches.map((branch) => branch.id)).size,
        result.branches.length
      )
      for (const tree of result.trees)
        assert.ok(tree.branches.length >= 1 && tree.branches.length <= 48)
    }
  }
})

test('forest import rejects unknown, malformed, incomplete, sparse and unsafe data', () => {
  const corruptions = [
    (f) => {
      f.version = 2
    },
    (f) => {
      delete f.tuning
    },
    (f) => {
      f.extra = 1
    },
    (f) => {
      f.scale = '__proto__'
    },
    (f) => {
      f.scale = 'dorian'
    },
    (f) => {
      f.tuning = NaN
    },
    (f) => {
      f.gain = Infinity
    },
    (f) => {
      f.pink = 1
    },
    (f) => {
      f.trees = []
    },
    (f) => {
      f.trees = Array(1)
    },
    (f) => {
      f.trees.push(...Array(3).fill(f.trees[0]))
    },
    (f) => {
      f.trees.push({ ...f.trees[0] })
    },
    (f) => {
      f.trees[0].seed = 0.5
    },
    (f) => {
      f.trees[0].enabled = 1
    },
    (f) => {
      f.trees[0].shape = 'rectangle'
    },
    (f) => {
      f.trees[0].x = -1
    },
    (f) => {
      f.trees[0].id = '" onclick="x'
    },
    (f) => {
      f.trees[0].extra = 1
    },
    (f) => {
      f.lowCut = f.highCut
    },
    (f) => {
      f.tonic = 2.5
    },
    (f) => {
      f.shift = 1.5
    },
    (f) => {
      Object.defineProperty(f, '__proto__', { value: {} })
    }
  ]
  for (const corrupt of corruptions) {
    const forest = createDefaultForest()
    corrupt(forest)
    assert.throws(() => normalizeForest(forest))
  }
  for (const invalid of [
    undefined,
    null,
    [],
    'forest',
    Object.create(createDefaultForest())
  ])
    assert.throws(() => normalizeForest(invalid))
  const getter = createDefaultForest()
  Object.defineProperty(getter, 'tuning', {
    get() {
      throw new Error('must not execute getter')
    }
  })
  assert.throws(() => normalizeForest(getter), /accessor/)
  const arrayGetter = createDefaultForest()
  Object.defineProperty(arrayGetter.trees, '0', {
    get() {
      throw new Error('must not execute array getter')
    }
  })
  assert.throws(() => normalizeForest(arrayGetter), /элемент/)
  for (const [key, { min, max }] of Object.entries(FOREST_RANGES)) {
    if (['seed', 'x', 'density', 'height', 'width'].includes(key)) continue
    assert.throws(() =>
      normalizeForest({ ...createDefaultForest(), [key]: min - 1 })
    )
    assert.throws(() =>
      normalizeForest({ ...createDefaultForest(), [key]: max + 1 })
    )
  }
})

test('project v1 migrates its music intact to v2 with a default forest', () => {
  const modern = createDemoProject()
  assert.equal(modern.version, 2)
  const legacy = structuredClone(modern)
  legacy.version = 1
  delete legacy.forest
  const migrated = normalizeProject(legacy)
  assert.deepEqual(migrated, modern)
  assert.deepEqual(migrated.tracks, legacy.tracks)
  assert.deepEqual(migrated.chords, legacy.chords)
  assert.throws(() =>
    normalizeProject({ ...legacy, forest: createDefaultForest() })
  )
  const missingForest = structuredClone(modern)
  delete missingForest.forest
  assert.throws(() => normalizeProject(missingForest))
})

test('project v2 persists exact forest controls and keeps cloned forests independent', () => {
  const project = createDemoProject()
  project.forest.trees[0].shape = 'fan'
  project.forest.trees[0].seed = 1234
  project.forest.noise = 0.17
  project.forest.rain = 0.4
  project.forest.scale = 'free'
  project.forest.shift = -5
  const restored = normalizeProject(JSON.parse(JSON.stringify(project)))
  assert.deepEqual(restored, project)
  assert.deepEqual(
    generateForest(restored.forest),
    generateForest(project.forest)
  )
  const cloned = cloneProject(project)
  cloned.forest.trees[0].seed = 42
  cloned.forest.decay = 5
  assert.equal(project.forest.trees[0].seed, 1234)
  assert.equal(project.forest.decay, 2.4)
})
