const TAU = Math.PI * 2
const LOG_1000 = Math.log(1000)
const clamp = (value, low, high) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low))
const DEFAULTS = {
  algorithm: 0.35,
  noise: 0,
  thru: 0,
  filter: 2400,
  bandwidth: 2,
  pink: true,
  wind: 0.3,
  windSpeed: 0.3,
  rain: 0,
  rainSpeed: 2,
  rainCenter: 0.5,
  rainSpread: 1,
  lowCut: 180,
  highCut: 7000,
  gain: 0.65
}

function hash(value) {
  let result = 2166136261
  for (const character of String(value))
    result = Math.imul(result ^ character.charCodeAt(0), 16777619)
  return result >>> 0
}

function gradient(index, seed) {
  let value = Math.imul(index ^ seed, 1597334677)
  value = Math.imul(value ^ (value >>> 16), 2246822519)
  return value & 1 ? 1 : -1
}

function smoothField(position, seed) {
  const cell = Math.floor(position)
  const fraction = position - cell
  const blend = fraction ** 3 * (fraction * (fraction * 6 - 15) + 10)
  const left = gradient(cell, seed) * fraction
  const right = gradient(cell + 1, seed) * (fraction - 1)
  return (left + (right - left) * blend) * 2
}

export function nearestBranch(branches, midi) {
  const frequency = 440 * 2 ** ((midi - 69) / 12)
  let nearest = null
  let distance = Infinity
  for (const branch of branches) {
    if (!(branch.gain > 0) || !(branch.frequency > 0)) continue
    const current = Math.abs(Math.log2(branch.frequency / frequency))
    if (current < distance) {
      distance = current
      nearest = branch
    }
  }
  return nearest
}

export class ForestDSP {
  constructor(sampleRate, { branches = [], params = {} } = {}) {
    this.sampleRate = clamp(sampleRate, 8000, 192000)
    this.time = 0
    this.ambient = false
    this.ambientGain = 0
    this.pending = []
    this.states = []
    this.byId = new Map()
    this.seed = hash(
      (params.trees ?? []).map((tree) => tree.seed).join(':') || 'forest'
    )
    this.randomState = this.seed || 1
    this.pinkState = new Float64Array(7)
    this.filterState = [0, 0, 0, 0]
    this.rainCountdown = 0.15
    this.strikeCount = 0
    this.rainCount = 0
    this.onStrike = null
    this.configure({ branches, params })
  }

  random() {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 4294967296
  }

  configure({ branches = [], params = {} }) {
    this.params = { ...DEFAULTS, ...params }
    const previous = this.byId
    this.states = branches
      .filter((branch) => branch.gain > 0)
      .slice(0, 144)
      .map((branch) => {
        const state = previous.get(branch.id) ?? {
          re: 0,
          im: 0,
          y1: 0,
          y2: 0,
          mallet: 0,
          malletGain: 0,
          malletLow: 0,
          malletHigh: 0,
          token: null,
          damped: false,
          currentGain: 0
        }
        state.branch = branch
        const frequency = clamp(branch.frequency, 20, this.sampleRate * 0.44)
        const angle = (TAU * frequency) / this.sampleRate
        state.cos = Math.cos(angle)
        state.sin = Math.sin(angle)
        state.radius = Math.exp(
          -LOG_1000 / (clamp(branch.decay, 0.05, 20) * this.sampleRate)
        )
        state.releaseRadius = Math.exp(-LOG_1000 / (0.25 * this.sampleRate))
        state.noiseNorm = Math.sqrt(1 - state.radius ** 2)
        const pan = ((clamp(branch.pan, -1, 1) + 1) * Math.PI) / 4
        state.left = Math.cos(pan)
        state.right = Math.sin(pan)
        return state
      })
    this.byId = new Map(this.states.map((state) => [state.branch.id, state]))
    const ordered = [...this.states].sort(
      (left, right) => left.branch.frequency - right.branch.frequency
    )
    const spread = clamp(this.params.rainSpread, 0, 1)
    const center = clamp(this.params.rainCenter, 0, 1)
    const radius = Math.max(0.5 / Math.max(1, ordered.length), spread / 2)
    let selected = ordered.filter((state, index) => {
      const position = ordered.length <= 1 ? 0.5 : index / (ordered.length - 1)
      return spread >= 0.999 || Math.abs(position - center) <= radius
    })
    if (!selected.length && ordered.length)
      selected = [ordered[Math.round(center * (ordered.length - 1))]]
    this.rainBranches = selected
    this.lowCoefficient =
      1 -
      Math.exp(
        (-TAU * clamp(this.params.lowCut, 20, this.sampleRate * 0.44)) /
          this.sampleRate
      )
    this.highCoefficient =
      1 -
      Math.exp(
        (-TAU * clamp(this.params.highCut, 30, this.sampleRate * 0.45)) /
          this.sampleRate
      )
  }

  enqueue(event) {
    this.pending.push({
      ...event,
      time: Number.isFinite(event.time) ? event.time : this.time
    })
    this.pending.sort((left, right) => left.time - right.time)
  }

  setAmbient(enabled) {
    if (enabled && !this.ambient)
      for (const state of this.states) state.damped = false
    this.ambient = Boolean(enabled)
  }

  strike(branchId, velocity = 0.8, token = null, source = 'manual') {
    const state = this.byId.get(branchId)
    if (!state) return null
    state.mallet = Math.round(this.sampleRate * 0.004)
    state.malletGain = clamp(velocity, 0, 1) * 0.32
    state.token = token
    state.damped = false
    this.strikeCount += 1
    if (source === 'rain') this.rainCount += 1
    this.onStrike?.({ branchId, velocity, time: this.time, source })
    return state.branch
  }

  damp(branchId, token = null) {
    const state = this.byId.get(branchId)
    if (state && (token === null || token === state.token)) {
      state.damped = true
      state.dampUntil = this.time + 0.3
    }
  }

  releaseAll() {
    this.ambient = false
    for (const state of this.states) {
      state.damped = true
      state.dampUntil = Infinity
      state.mallet = 0
    }
  }

  clear() {
    this.pending = []
    this.ambient = false
    this.ambientGain = 0
    this.filterState.fill(0)
    this.pinkState.fill(0)
    for (const state of this.states) {
      state.re = state.im = state.y1 = state.y2 = 0
      state.mallet = state.malletLow = state.malletHigh = 0
      state.damped = false
    }
  }

  filterCoefficients(center) {
    const angle =
      (TAU * clamp(center, 30, this.sampleRate * 0.44)) / this.sampleRate
    const sin = Math.sin(angle)
    const width = clamp(this.params.bandwidth, 0.2, 8)
    const alpha =
      sin * Math.sinh(((Math.LN2 / 2) * width * angle) / Math.max(0.001, sin))
    const inverse = 1 / (1 + alpha)
    this.b0 = alpha * inverse
    this.b2 = -this.b0
    this.a1 = -2 * Math.cos(angle) * inverse
    this.a2 = (1 - alpha) * inverse
  }

  noise(white) {
    if (!this.params.pink) return white
    const b = this.pinkState
    b[0] = 0.99886 * b[0] + white * 0.0555179
    b[1] = 0.99332 * b[1] + white * 0.0750759
    b[2] = 0.969 * b[2] + white * 0.153852
    b[3] = 0.8665 * b[3] + white * 0.3104856
    b[4] = 0.55 * b[4] + white * 0.5329522
    b[5] = -0.7616 * b[5] - white * 0.016898
    const value =
      (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362) * 0.11
    b[6] = white * 0.115926
    return value
  }

  applyEvent(event) {
    if (event.type === 'strike')
      this.strike(event.branchId, event.velocity, event.token, event.source)
    else if (event.type === 'damp') this.damp(event.branchId, event.token)
    else if (event.type === 'ambient') this.setAmbient(event.enabled)
    else if (event.type === 'releaseAll') this.releaseAll()
    else if (event.type === 'clear') this.clear()
  }

  process(left, right, startTime = this.time) {
    this.time = startTime
    const duration = left.length / this.sampleRate
    const quiet =
      !this.ambient &&
      this.ambientGain < 1e-8 &&
      (!this.pending.length || this.pending[0].time >= startTime + duration) &&
      this.states.every(
        (state) =>
          state.mallet === 0 &&
          Math.abs(state.re) +
            Math.abs(state.im) +
            Math.abs(state.y1) +
            Math.abs(state.y2) <
            1e-10
      )
    if (quiet) {
      left.fill(0)
      right.fill(0)
      this.time = startTime + duration
      return
    }
    const wind = clamp(this.params.wind, 0, 1)
    const speed = clamp(this.params.windSpeed, 0.03, 3)
    const field = smoothField(startTime * speed, this.seed)
    const endField = smoothField((startTime + duration) * speed, this.seed)
    this.filterCoefficients(this.params.filter * 2 ** (wind * field * 0.7))
    for (const state of this.states) {
      state.wind =
        1 +
        wind *
          0.35 *
          smoothField(startTime * speed + state.branch.x2 * 0.75, this.seed)
    }
    const countGain = 1.2 / Math.sqrt(Math.max(1, this.states.length))
    const algo = clamp(this.params.algorithm, 0, 1)
    const master = clamp(this.params.gain, 0, 1) * 0.28
    const rainAmount = clamp(this.params.rain, 0, 1)
    const f = this.filterState
    for (let index = 0; index < left.length; index += 1) {
      this.time = startTime + index / this.sampleRate
      while (
        this.pending.length &&
        this.pending[0].time <= this.time + 0.5 / this.sampleRate
      )
        this.applyEvent(this.pending.shift())
      this.ambientGain +=
        ((this.ambient && this.states.length ? 1 : 0) - this.ambientGain) *
        0.002
      if (this.ambient && rainAmount > 0 && this.rainBranches.length) {
        this.rainCountdown -= 1 / this.sampleRate
        if (this.rainCountdown <= 0) {
          const branch =
            this.rainBranches[
              Math.floor(this.random() * this.rainBranches.length)
            ].branch
          this.strike(
            branch.id,
            Math.sqrt(rainAmount) * (0.45 + 0.55 * this.random()),
            null,
            'rain'
          )
          this.rainCountdown =
            -Math.log(Math.max(0.000001, 1 - this.random())) /
            clamp(this.params.rainSpeed, 0.1, 12)
        }
      }
      const white = this.random() * 2 - 1
      const colored = this.noise(white)
      let filtered =
        this.b0 * colored + this.b2 * f[1] - this.a1 * f[2] - this.a2 * f[3]
      f[1] = f[0]
      f[0] = colored
      f[3] = f[2]
      f[2] = filtered
      if (!Number.isFinite(filtered)) {
        this.filterState.fill(0)
        filtered = 0
      }
      const windGain =
        1 + wind * 0.6 * (field + ((endField - field) * index) / left.length)
      const excitation =
        filtered *
        clamp(this.params.noise, 0, 1) *
        countGain *
        windGain *
        this.ambientGain
      let outLeft =
        colored * clamp(this.params.thru, 0, 1) * this.ambientGain * 0.3
      let outRight = outLeft
      for (const state of this.states) {
        let mallet = 0
        if (state.mallet > 0) {
          const phase = 1 - state.mallet / (this.sampleRate * 0.004)
          const burst =
            (this.random() * 2 - 1) * state.malletGain * Math.exp(-phase * 5)
          state.malletHigh += this.highCoefficient * (burst - state.malletHigh)
          state.malletLow +=
            this.lowCoefficient * (state.malletHigh - state.malletLow)
          mallet = state.malletHigh - state.malletLow
          state.mallet -= 1
        }
        const input = excitation * state.noiseNorm + mallet
        if (state.damped && this.time >= state.dampUntil) state.damped = false
        const radius = state.damped ? state.releaseRadius : state.radius
        const re =
          radius * (state.cos * state.re - state.sin * state.im) + input
        state.im = radius * (state.sin * state.re + state.cos * state.im)
        state.re = re
        const sample =
          2 * radius * state.cos * state.y1 -
          radius * radius * state.y2 +
          input * state.sin
        state.y2 = state.y1
        state.y1 = sample
        state.currentGain += (state.branch.gain - state.currentGain) * 0.002
        const value =
          ((1 - algo) * state.re + algo * sample) *
          state.currentGain *
          state.wind
        if (!Number.isFinite(value)) {
          state.re = state.im = state.y1 = state.y2 = 0
          continue
        }
        outLeft += value * state.left
        outRight += value * state.right
      }
      left[index] = Math.tanh(outLeft * master)
      right[index] = Math.tanh(outRight * master)
    }
    this.time = startTime + duration
  }
}

export function renderForest({
  sampleRate = 44100,
  duration,
  branches,
  params,
  events = []
}) {
  const dsp = new ForestDSP(sampleRate, { branches, params })
  for (const event of events) dsp.enqueue(event)
  const left = new Float32Array(Math.ceil(sampleRate * duration))
  const right = new Float32Array(left.length)
  for (let offset = 0; offset < left.length; offset += 128) {
    const end = Math.min(left.length, offset + 128)
    dsp.process(
      left.subarray(offset, end),
      right.subarray(offset, end),
      offset / sampleRate
    )
  }
  return { left, right, strikeCount: dsp.strikeCount, rainCount: dsp.rainCount }
}
