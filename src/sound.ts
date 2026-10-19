// An entirely synthesized soundtrack: no remote assets, downloads or autoplay.
export class Soundscape {
  private readonly context = new AudioContext()
  private readonly master = this.context.createGain()
  private readonly drone = this.context.createGain()
  private readonly texture = this.context.createGain()
  private readonly voices: OscillatorNode[] = []
  private readonly noise: AudioBufferSourceNode
  private step = 0
  private lastRipple = 0

  constructor() {
    const compressor = this.context.createDynamicsCompressor()
    compressor.threshold.value = -20
    compressor.ratio.value = 4
    this.master.gain.value = 0.0001
    this.master.connect(compressor).connect(this.context.destination)
    this.drone.gain.value = 0.035
    this.drone.connect(this.master)

    // A low, gently detuned mineral drone, complemented by a soft noise bed.
    for (const [frequency, detune] of [[55, -3], [82.41, 2], [110, 4]]) {
      const oscillator = this.context.createOscillator()
      const gain = this.context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      oscillator.detune.value = detune
      gain.gain.value = frequency === 55 ? 0.55 : 0.22
      oscillator.connect(gain).connect(this.drone)
      oscillator.start()
      this.voices.push(oscillator)
    }
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate)
    const samples = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1
    this.noise = this.context.createBufferSource()
    this.noise.buffer = buffer
    this.noise.loop = true
    const filter = this.context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 380
    this.texture.gain.value = 0.002
    this.noise.connect(filter).connect(this.texture).connect(this.master)
    this.noise.start()
  }

  async start() {
    await this.context.resume()
    if (this.context.state !== 'running') throw new Error('Audio could not be started')
    this.master.gain.setTargetAtTime(0.65, this.context.currentTime, 0.8)
  }

  update(phase: number) {
    const now = this.context.currentTime
    // Signal is airy; Mind is fuller; Potential settles into a darker bed.
    const mind = Math.max(0, 1 - Math.abs(phase - 1))
    const ore = Math.max(0, 1 - Math.abs(phase - 2))
    this.drone.gain.setTargetAtTime(0.028 + mind * 0.012 + ore * 0.006, now, 0.8)
    this.texture.gain.setTargetAtTime(0.002 + mind * 0.001 + ore * 0.0015, now, 0.8)
  }

  note(phase: number) {
    const signal = [220, 329.63, 440, 329.63, 261.63, 329.63, 196, 329.63]
    const mind = [220, 261.63, 329.63, 392, 329.63, 261.63, 246.94, 329.63]
    const ore = [164.81, 220, 246.94, 329.63, 220, 196, 246.94, 329.63]
    const score = phase < 0.5 || phase > 2.5 ? signal : phase < 1.5 ? mind : ore
    this.tone(score[this.step % score.length], 0.014, 2.4)
    this.step += 1
  }

  cue(kind: 'navigation' | 'ripple') {
    const now = this.context.currentTime
    if (kind === 'ripple') {
      if (now - this.lastRipple < 0.8) return
      this.lastRipple = now
      this.tone(620 + Math.random() * 90, 0.004, 0.65)
    } else {
      this.tone(440, 0.009, 0.8)
      this.tone(660, 0.004, 1.1)
    }
  }

  transition(scene: number, forward: boolean) {
    if (this.context.state !== 'running' || !this.noise.buffer) return
    const now = this.context.currentTime
    const source = this.context.createBufferSource()
    const filter = this.context.createBiquadFilter()
    const envelope = this.context.createGain()
    source.buffer = this.noise.buffer
    filter.type = 'bandpass'
    filter.Q.value = 0.8
    const middle = [900, 560, 720][scene]
    filter.frequency.setValueAtTime(forward ? middle * 0.45 : middle * 1.7, now)
    filter.frequency.exponentialRampToValueAtTime(forward ? middle * 1.7 : middle * 0.45, now + 1.3)
    envelope.gain.setValueAtTime(0.0001, now)
    envelope.gain.exponentialRampToValueAtTime(0.025, now + 0.3)
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.55)
    source.connect(filter).connect(envelope).connect(this.master)
    source.start(now)
    source.stop(now + 1.6)
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect() }

    // A low, soft harmonic gives each handoff a sense of weight.
    this.tone([164.81, 110, 146.83][scene], 0.008, 1.8)
  }

  private tone(frequency: number, volume: number, duration: number) {
    if (this.context.state !== 'running') return
    const now = this.context.currentTime
    const oscillator = this.context.createOscillator()
    const envelope = this.context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    envelope.gain.setValueAtTime(0.0001, now)
    envelope.gain.exponentialRampToValueAtTime(volume, now + 0.08)
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    oscillator.connect(envelope).connect(this.master)
    oscillator.start(now)
    oscillator.stop(now + duration + 0.02)
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect() }
  }

  suspend() { return this.context.suspend() }
  resume() { return this.context.resume() }

  async close() {
    this.voices.forEach((voice) => voice.stop())
    this.noise.stop()
    await this.context.close()
  }
}
