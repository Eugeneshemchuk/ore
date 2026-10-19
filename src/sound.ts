/// <reference types="vite/client" />
// Sound is opt-in; the supplied Matrix sample is loaded only after activation.
export class Soundscape {
  private readonly context = new AudioContext()
  private readonly master = this.context.createGain()
  private readonly drone = this.context.createGain()
  private readonly texture = this.context.createGain()
  private readonly networkMotion = this.context.createGain()
  private readonly networkAir = this.context.createGain()
  private readonly glyphSampleGain = this.context.createGain()
  private readonly neuralSampleGain = this.context.createGain()
  private readonly asteroidHumGain = this.context.createGain()
  private glyphSample: AudioBufferSourceNode | null = null
  private neuralSample: AudioBufferSourceNode | null = null
  private asteroidHum: AudioBufferSourceNode | null = null
  private crystalZoomBuffer: AudioBuffer | null = null
  private readonly voices: OscillatorNode[] = []
  private readonly noise: AudioBufferSourceNode
  private step = 0
  private lastRipple = -Infinity

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
    // A quiet low-frequency field that follows movement through the network.
    const networkOscillator = this.context.createOscillator()
    networkOscillator.type = 'sine'
    networkOscillator.frequency.value = 52
    this.networkMotion.gain.value = 0
    networkOscillator.connect(this.networkMotion).connect(this.master)
    networkOscillator.start()
    this.voices.push(networkOscillator)
    const networkFilter = this.context.createBiquadFilter()
    networkFilter.type = 'lowpass'
    networkFilter.frequency.value = 150
    this.networkAir.gain.value = 0
    this.noise.connect(networkFilter).connect(this.networkAir).connect(this.master)
    this.glyphSampleGain.gain.value = 0
    this.glyphSampleGain.connect(this.master)
    this.neuralSampleGain.gain.value = 0
    this.neuralSampleGain.connect(this.master)
    this.asteroidHumGain.gain.value = 0
    this.asteroidHumGain.connect(this.master)
    this.noise.start()
  }

  async start() {
    await this.context.resume()
    if (this.context.state !== 'running') throw new Error('Audio could not be started')
    this.master.gain.setTargetAtTime(0.65, this.context.currentTime, 0.15)
    // An audible confirmation above the phone-speaker bass range.
    this.tone(523.25, 0.025, 1.1, 0.12)
    this.tone(783.99, 0.012, 1.0, 0.24)
    void this.loadGlyphSample()
    void this.loadNeuralSample()
    void this.loadCrystalZoomSample()
    void this.loadAsteroidHum()
  }

  private async loadAsteroidHum() {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}audio/asteroid-hum.mp3`)
      if (!response.ok) throw new Error('Asteroid audio unavailable')
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer())
      if (this.context.state === 'closed') return
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.connect(this.asteroidHumGain)
      source.start()
      this.asteroidHum = source
    } catch {
      // Other sounds remain available if the hover recording cannot load.
    }
  }

  asteroidHover(active: boolean) {
    this.asteroidHumGain.gain.setTargetAtTime(active ? 0.12 : 0, this.context.currentTime, active ? 0.2 : 0.35)
  }

  private async loadCrystalZoomSample() {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}audio/crystal-shatter.mp3`)
      if (!response.ok) throw new Error('Crystal audio unavailable')
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer())
      if (this.context.state !== 'closed') this.crystalZoomBuffer = buffer
    } catch {
      // Leave the crystal close-up silent if the recording cannot load.
    }
  }

  crystalZoom() {
    if (!this.crystalZoomBuffer || this.context.state !== 'running') return
    const source = this.context.createBufferSource()
    const gain = this.context.createGain()
    source.buffer = this.crystalZoomBuffer
    gain.gain.value = 0.3
    source.connect(gain).connect(this.master)
    source.onended = () => { source.disconnect(); gain.disconnect() }
    source.start()
  }

  private async loadNeuralSample() {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}audio/neural-space.mp3`)
      if (!response.ok) throw new Error('Neural audio unavailable')
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer())
      if (this.context.state === 'closed') return
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.connect(this.neuralSampleGain)
      source.start()
      this.neuralSample = source
    } catch {
      // Other sounds remain available if this recording cannot load.
    }
  }

  private async loadGlyphSample() {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}audio/matrix-warp.mp3`)
      if (!response.ok) throw new Error('Matrix audio unavailable')
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer())
      if (this.context.state === 'closed') return
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.connect(this.glyphSampleGain)
      source.start()
      this.glyphSample = source
    } catch {
      // If the recording cannot load, the glyph zoom remains silent.
    }
  }

  update(phase: number) {
    const now = this.context.currentTime
    // Signal is airy; Mind is fuller; Potential settles into a darker bed.
    const mind = Math.max(0, 1 - Math.abs(phase - 1))
    const ore = Math.max(0, 1 - Math.abs(phase - 2))
    const fade = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }
    // Carry the space recording through Mind and Potential, fading it at either Signal transition.
    const signalDeparture = phase <= 2 ? Math.min(phase, 1) : 3 - phase
    const neuralPresence = fade((signalDeparture - 0.55) / 0.35)
    this.neuralSampleGain.gain.setTargetAtTime(neuralPresence * 0.3, now, 0.35)
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

  networkMovement(intensity: number) {
    const level = Math.max(0, Math.min(1, intensity))
    const now = this.context.currentTime
    this.networkMotion.gain.setTargetAtTime(level * 0.014, now, level ? 0.12 : 0.4)
    this.networkAir.gain.setTargetAtTime(level * 0.009, now, level ? 0.12 : 0.4)
  }

  glyphZoom(intensity: number) {
    const level = Math.max(0, Math.min(1, intensity))
    const now = this.context.currentTime
    this.glyphSampleGain.gain.setTargetAtTime(level * 0.22, now, level ? 0.18 : 0.35)
  }

  cue(kind: 'navigation' | 'crystal') {
    const now = this.context.currentTime
    if (kind === 'crystal') {
      if (now - this.lastRipple < 0.65) return
      this.lastRipple = now
      // Inharmonic, staggered partials suggest tiny crystals forming, not a UI beep.
      const root = 760 + Math.random() * 130
      this.tone(root, 0.004, 1.15)
      this.tone(root * 1.51, 0.0025, 0.85, 0.07)
      this.tone(root * 2.17, 0.0015, 0.65, 0.15)
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
    // Signal → Mind: airy electronic sweep. Mind → Potential: low, mineral
    // descent. Potential → Signal: brighter, shorter dispersal.
    const profiles = [
      { from: 360, to: 1900, duration: 1.45, peak: 0.018, q: 1.5 },
      { from: 1150, to: 120, duration: 2.0, peak: 0.023, q: 0.65 },
      { from: 2300, to: 700, duration: 0.95, peak: 0.014, q: 2.2 },
    ]
    const profile = profiles[scene]
    filter.Q.value = profile.q
    filter.frequency.setValueAtTime(forward ? profile.from : profile.to, now)
    filter.frequency.exponentialRampToValueAtTime(forward ? profile.to : profile.from, now + profile.duration)
    envelope.gain.setValueAtTime(0.0001, now)
    envelope.gain.exponentialRampToValueAtTime(profile.peak, now + profile.duration * 0.25)
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + profile.duration + 0.2)
    source.connect(filter).connect(envelope).connect(this.master)
    source.start(now)
    source.stop(now + profile.duration + 0.25)
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect() }

    if (scene === 0) {
      this.tone(246.94, 0.006, 1.5)
      this.tone(369.99, 0.004, 1.2, 0.22)
    } else if (scene === 1) {
      this.tone(82.41, 0.012, 2.3)
      this.tone(164.81, 0.004, 1.7, 0.15)
    } else {
      this.tone(523.25, 0.004, 1.1)
      this.tone(783.99, 0.0025, 0.8, 0.12)
    }
  }

  private tone(frequency: number, volume: number, duration: number, delay = 0) {
    if (this.context.state !== 'running') return
    const now = this.context.currentTime + delay
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
  get isRunning() { return this.context.state === 'running' }

  async close() {
    this.voices.forEach((voice) => voice.stop())
    this.noise.stop()
    this.glyphSample?.stop()
    this.neuralSample?.stop()
    this.asteroidHum?.stop()
    await this.context.close()
  }
}
