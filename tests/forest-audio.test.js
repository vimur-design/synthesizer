import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ForestDSP,
  nearestBranch,
  renderForest
} from '../src/javascript/forest-audio.js'

const sampleRate = 44100
const branch = (id = 'a', frequency = 443.3, overrides = {}) => ({
  id,
  treeId: 'tree',
  frequency,
  gain: 0.8,
  decay: 0.8,
  pan: 0,
  x2: 0.5,
  ...overrides
})
const params = {
  noise: 0,
  rain: 0,
  thru: 0,
  wind: 0,
  gain: 0.8,
  filter: 440,
  bandwidth: 2,
  pink: false
}
const rms = (samples) =>
  Math.sqrt(
    samples.reduce((sum, value) => sum + value * value, 0) / samples.length
  )
const render = (branches, options = {}, events = [], duration = 3) =>
  renderForest({
    sampleRate,
    duration,
    branches,
    params: { ...params, ...options },
    events
  })
const strike = (id = 'a') => ({
  type: 'strike',
  time: 0.01,
  branchId: id,
  velocity: 0.8,
  token: 1
})
const ambient = { type: 'ambient', time: 0, enabled: true }

test('a branch is silent until excited, rings, and naturally decays without a prerecorded buffer', () => {
  const silence = render([branch()])
  assert.equal(rms(silence.left), 0)
  const ringing = render([branch()], {}, [strike()])
  assert.ok(rms(ringing.left.subarray(1000, 10000)) > 0.0001)
  assert.ok(rms(ringing.left.subarray(sampleRate * 2.5)) < 0.000001)
})

test('resonator tuning follows its floating-point frequency', () => {
  const sound = render([branch()], { algorithm: 0 }, [strike()], 0.6).left
  const energyAt = (frequency) => {
    let real = 0
    let imaginary = 0
    for (let index = 2205; index < 15435; index += 1) {
      const angle = (Math.PI * 2 * frequency * index) / sampleRate
      real += sound[index] * Math.cos(angle)
      imaginary += sound[index] * Math.sin(angle)
    }
    return real * real + imaginary * imaginary
  }
  assert.ok(energyAt(443.3) > energyAt(439.3) * 1.5)
  assert.ok(energyAt(443.3) > energyAt(447.3) * 1.5)
})

test('two resonator algorithms produce different signals while retaining finite output', () => {
  const complex = render([branch()], { algorithm: 0 }, [strike()]).left
  const twoPole = render([branch()], { algorithm: 1 }, [strike()]).left
  assert.ok(rms(complex.map((value, index) => value - twoPole[index])) > 0.0001)
  assert.ok(twoPole.every(Number.isFinite))
})

test('continuous filtered noise excites modes and releaseAll ends the tail', () => {
  const sound = render([branch()], { noise: 0.7 }, [
    ambient,
    { type: 'releaseAll', time: 1.5 }
  ])
  assert.ok(rms(sound.left.subarray(22050, 44100)) > 0.001)
  assert.ok(rms(sound.left.subarray(110250)) < 0.000001)
})

test('audition can restart after releaseAll without permanently shortening branch decay', () => {
  const sound = render(
    [branch('a', 440, { decay: 8 })],
    { noise: 0.7 },
    [
      ambient,
      { type: 'releaseAll', time: 3 },
      { type: 'ambient', time: 4, enabled: true }
    ],
    8
  )
  const first = rms(sound.left.subarray(sampleRate * 2, sampleRate * 3))
  const second = rms(sound.left.subarray(sampleRate * 7, sampleRate * 8))
  assert.ok(second > first * 0.5, `restarted ${second}, original ${first}`)
})

test('rain selects individual resonators by low-to-high Center/Spread and has stochastic intervals', () => {
  const branches = [
    branch('low', 150),
    branch('mid', 440),
    branch('high', 1400)
  ]
  const dsp = new ForestDSP(sampleRate, {
    branches,
    params: {
      ...params,
      rain: 0.7,
      rainSpeed: 10,
      rainCenter: 0,
      rainSpread: 0
    }
  })
  const strikes = []
  dsp.onStrike = (event) => strikes.push(event)
  dsp.setAmbient(true)
  for (let block = 0; block < 1400; block += 1)
    dsp.process(new Float32Array(128), new Float32Array(128))
  assert.ok(strikes.length > 10)
  assert.ok(strikes.every((event) => event.branchId === 'low'))
  const gaps = strikes
    .slice(1)
    .map((event, index) => event.time - strikes[index].time)
  assert.ok(Math.max(...gaps) > Math.min(...gaps) * 2)
})

test('disabled trees remain silent even with Noise, Thru, and Rain at maximum', () => {
  const sound = render(
    [branch('disabled', 440, { gain: 0 })],
    { noise: 1, thru: 1, rain: 1 },
    [ambient, strike('disabled')]
  )
  assert.equal(rms(sound.left), 0)
  assert.equal(sound.rainCount, 0)
  assert.equal(sound.strikeCount, 0)
})

test('branch panning produces independently routed stereo channels', () => {
  const sound = render([branch('a', 440, { pan: 1 })], {}, [strike()])
  assert.ok(rms(sound.right) > 0.0001)
  assert.ok(rms(sound.left) < rms(sound.right) / 1000)
})

test('live configuration preserves an already ringing mode', () => {
  const dsp = new ForestDSP(sampleRate, { branches: [branch()], params })
  dsp.strike('a', 0.8)
  for (let index = 0; index < 100; index += 1)
    dsp.process(new Float32Array(128), new Float32Array(128))
  dsp.configure({
    branches: [branch()],
    params: { ...params, wind: 0.5, algorithm: 0.8 }
  })
  const next = new Float32Array(2048)
  dsp.process(next, new Float32Array(next.length))
  assert.ok(rms(next) > 0.0001)
})

test('nearest MIDI targeting uses audible resonator frequency and excludes disabled branches', () => {
  const branches = [
    branch('disabled', 440, { gain: 0 }),
    branch('lower', 400),
    branch('upper', 480)
  ]
  assert.equal(nearestBranch(branches, 69).id, 'upper')
  assert.equal(nearestBranch([branches[0]], 69), null)
})

test('maximum-size bank stays finite and bounded under strong exciters', () => {
  const branches = Array.from({ length: 144 }, (_, index) =>
    branch(`b${index}`, 35 * 2 ** (index / 22), {
      decay: 12,
      pan: (index / 143) * 2 - 1
    })
  )
  const sound = render(
    branches,
    {
      noise: 1,
      thru: 1,
      rain: 1,
      rainSpeed: 12,
      wind: 1,
      windSpeed: 3,
      algorithm: 1,
      filter: 16000,
      bandwidth: 8,
      lowCut: 20,
      highCut: 20000
    },
    [ambient],
    2
  )
  assert.ok(
    sound.left.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)
  )
  assert.ok(
    sound.right.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)
  )
})
