// Tiny self-contained WebAudio SFX — no asset files (Devvit CSP friendly).
// All sounds are synthesized. Context is created lazily and resumed on the
// first user gesture (browser autoplay policy).

class Sfx {
  private ctx: AudioContext | null = null;
  private muted = false;

  private ac(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Call once from a user gesture so audio is unlocked. */
  unlock(): void {
    this.ac();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m && this.ctx?.state === 'running') void this.ctx.suspend();
    if (!m) this.ac();
  }
  isMuted(): boolean {
    return this.muted;
  }

  private tone(freq: number, to: number, dur: number, type: OscillatorType, gain: number): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, cutoff: number): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t = ctx.currentTime;
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(ctx.destination);
    src.start(t);
  }

  place(): void {
    this.tone(200, 90, 0.09, 'sine', 0.25);
    this.noise(0.05, 0.08, 1200);
  }
  reinforce(): void {
    this.tone(660, 520, 0.06, 'square', 0.14);
    this.tone(990, 780, 0.08, 'square', 0.08);
  }
  collapse(): void {
    this.noise(0.5, 0.28, 900);
    this.tone(160, 50, 0.5, 'sawtooth', 0.16);
  }
  quake(mag: number): void {
    const g = 0.2 + mag * 0.25;
    this.noise(1.2, g, 320 + mag * 260);
    this.tone(80, 40, 1.2, 'sawtooth', g * 0.7);
  }
  /** A soft, low rumble for the mini-tremor between quakes. */
  tremor(): void {
    this.noise(0.34, 0.09, 260);
    this.tone(70, 48, 0.34, 'sine', 0.08);
  }
  beep(): void {
    this.tone(880, 880, 0.07, 'square', 0.09);
  }
  coin(): void {
    this.tone(880, 1320, 0.07, 'triangle', 0.14);
    this.tone(1320, 1760, 0.09, 'triangle', 0.1);
  }
}

export const sfx = new Sfx();
