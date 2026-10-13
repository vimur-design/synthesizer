import { ForestDSP } from './forest-audio.js'

class ForestProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.dsp = new ForestDSP(sampleRate, options.processorOptions)
    this.dsp.onStrike = (event) =>
      this.port.postMessage({ type: 'branch', ...event })
    this.blocks = 0
    this.alive = true
    this.port.onmessage = ({ data }) => {
      if (data.type === 'dispose') {
        this.alive = false
        this.dsp.clear()
      } else if (data.type === 'configure') this.dsp.configure(data.forest)
      else this.dsp.enqueue(data)
    }
  }

  process(_inputs, outputs) {
    if (!this.alive) return false
    const channels = outputs[0]
    if (!channels?.length) return true
    this.dsp.process(channels[0], channels[1] ?? channels[0], currentTime)
    if (++this.blocks % 32 === 0) {
      let squares = 0
      let peak = 0
      for (const channel of channels)
        for (const value of channel) {
          squares += value * value
          peak = Math.max(peak, Math.abs(value))
        }
      this.port.postMessage({
        type: 'stats',
        rms: Math.sqrt(squares / (channels.length * channels[0].length)),
        peak,
        branchCount: this.dsp.states.length,
        rainCount: this.dsp.rainCount,
        strikeCount: this.dsp.strikeCount,
        time: currentTime
      })
    }
    return true
  }
}

registerProcessor('forest-resonators', ForestProcessor)
