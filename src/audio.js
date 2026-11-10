/**
 * Everything is synthesised with WebAudio: no audio files to ship.
 * The context is created lazily on the first user gesture (browser autoplay rules).
 */
export class AudioSys {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicTimer = null;
    this.step = 0;
    this.nextTime = 0;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
    } catch {
      return false;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.34;
    this.music.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128 - 1) * 6;
      curve[i] = Math.tanh(x);
    }
    this.driveCurve = curve;
    return true;
  }

  /** Stop the clock (pause menu, hidden tab): scheduled sounds and the music freeze with it. */
  setSuspended(on) {
    if (!this.ctx) return;
    if (on && this.ctx.state === 'running') this.ctx.suspend();
    else if (!on && this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.8;
    return this.muted;
  }

  env(gain, t, attack, dur, peak) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  noise({ dur = 0.2, f0 = 1000, f1 = f0, type = 'lowpass', q = 1, gain = 0.5, attack = 0.004, delay = 0, out = this.sfx }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, attack, dur, gain);
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.2, gain = 0.4, attack = 0.004, delay = 0, drive = false, tremolo = 0, out = this.sfx }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, attack, dur, gain);
    let node = osc;
    if (drive) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.driveCurve;
      node = osc.connect(shaper);
    }
    if (tremolo) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = tremolo;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      const amp = ctx.createGain();
      amp.gain.value = 0.5;
      lfo.connect(depth).connect(amp.gain);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
      node = node.connect(amp);
    }
    node.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  play(name, o = {}) {
    if (!this.ctx || this.muted) return;
    const v = o.vol ?? 1;
    const p = o.pitch ?? 1;
    switch (name) {
      case 'swing':
        this.noise({ dur: 0.13, f0: 900, f1: 3200, type: 'bandpass', q: 2, gain: 0.22 * v });
        break;
      case 'swingHeavy':
        this.noise({ dur: 0.24, f0: 400, f1: 1800, type: 'bandpass', q: 1.5, gain: 0.36 * v });
        break;
      case 'hit':
        this.noise({ dur: 0.11, f0: 2600, f1: 500, gain: 0.55 * v });
        this.tone({ f0: 170, f1: 55, dur: 0.16, gain: 0.6 * v });
        break;
      case 'hitHeavy':
        this.noise({ dur: 0.22, f0: 3200, f1: 240, gain: 0.8 * v });
        this.tone({ f0: 130, f1: 34, dur: 0.34, gain: 0.95 * v, drive: true });
        this.tone({ type: 'square', f0: 420, f1: 90, dur: 0.1, gain: 0.18 * v });
        break;
      case 'block':
        this.tone({ type: 'square', f0: 950, f1: 620, dur: 0.07, gain: 0.2 * v });
        this.noise({ dur: 0.07, f0: 5200, type: 'highpass', gain: 0.3 * v });
        break;
      case 'guardBreak':
        this.tone({ type: 'sawtooth', f0: 900, f1: 110, dur: 0.4, gain: 0.4 * v });
        this.noise({ dur: 0.35, f0: 6000, f1: 800, gain: 0.5 * v });
        break;
      case 'dash':
        this.noise({ dur: 0.2, f0: 500, f1: 2600, type: 'bandpass', q: 0.8, gain: 0.25 * v });
        break;
      case 'lance':
        this.tone({ f0: 620, f1: 2500, dur: 0.22, gain: 0.3 * v });
        this.tone({ type: 'triangle', f0: 1240, f1: 3600, dur: 0.2, gain: 0.16 * v });
        this.noise({ dur: 0.22, f0: 3000, f1: 7000, type: 'bandpass', q: 3, gain: 0.2 * v });
        break;
      case 'beamCharge':
        this.tone({ type: 'sawtooth', f0: 90, f1: 880, dur: 0.82, gain: 0.3 * v, attack: 0.5, tremolo: 24 });
        this.tone({ f0: 300, f1: 2400, dur: 0.82, gain: 0.2 * v, attack: 0.6 });
        break;
      case 'beam': {
        const dur = o.dur ?? 1.25;
        this.noise({ dur, f0: 1800, f1: 900, type: 'bandpass', q: 0.7, gain: 0.5 * v, attack: 0.03 });
        this.tone({ type: 'sawtooth', f0: 220, f1: 196, dur, gain: 0.3 * v, attack: 0.03, tremolo: 31 });
        this.tone({ type: 'sawtooth', f0: 331, f1: 294, dur, gain: 0.2 * v, attack: 0.03, tremolo: 43 });
        this.tone({ f0: 1760, f1: 1320, dur, gain: 0.1 * v, attack: 0.03 });
        break;
      }
      case 'level':
        this.tone({ type: 'triangle', f0: 520 * p, f1: 1040 * p, dur: 0.16, gain: 0.22 * v });
        break;
      case 'grab':
        this.noise({ dur: 0.12, f0: 900, f1: 300, gain: 0.5 * v });
        this.tone({ f0: 210, f1: 120, dur: 0.14, gain: 0.4 * v });
        break;
      case 'stun':
        [1320, 990, 1320, 990].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.12, gain: 0.2 * v, delay: i * 0.09 }));
        break;
      case 'fire':
        this.noise({ dur: 0.5, f0: 2400, f1: 300, gain: 0.5 * v });
        this.tone({ type: 'sawtooth', f0: 260, f1: 70, dur: 0.45, gain: 0.3 * v, drive: true });
        break;
      case 'explosion':
        this.noise({ dur: 1.3 * (o.size ?? 1), f0: 1400, f1: 50, gain: 1.0 * v });
        this.tone({ f0: 95, f1: 26, dur: 1.0 * (o.size ?? 1), gain: 0.9 * v, drive: true });
        break;
      case 'collapse':
        this.noise({ dur: 0.9, f0: 520, f1: 70, gain: 0.5 * v, attack: 0.05 });
        this.noise({ dur: 0.4, f0: 3000, f1: 900, type: 'bandpass', gain: 0.14 * v });
        break;
      case 'step':
        this.tone({ f0: 74, f1: 36, dur: 0.2, gain: 0.5 * v });
        this.noise({ dur: 0.12, f0: 300, f1: 90, gain: 0.25 * v });
        break;
      case 'roar':
        this.tone({ type: 'sawtooth', f0: 190 * p, f1: 68 * p, dur: 1.25, gain: 0.5 * v, attack: 0.08, drive: true, tremolo: 23 });
        this.tone({ type: 'square', f0: 96 * p, f1: 48 * p, dur: 1.25, gain: 0.3 * v, attack: 0.1, tremolo: 17 });
        this.noise({ dur: 1.2, f0: 1500 * p, f1: 420 * p, type: 'bandpass', q: 1.2, gain: 0.4 * v, attack: 0.1 });
        break;
      case 'ko':
        this.tone({ f0: 110, f1: 22, dur: 1.6, gain: 1.0, drive: true });
        this.noise({ dur: 1.4, f0: 900, f1: 40, gain: 0.7 });
        break;
      case 'ui':
        this.tone({ type: 'triangle', f0: 880, f1: 1320, dur: 0.12, gain: 0.25 });
        break;
      case 'deny':
        this.tone({ type: 'square', f0: 180, f1: 140, dur: 0.12, gain: 0.16 });
        break;
      case 'ready':
        this.tone({ type: 'triangle', f0: 660, f1: 1320, dur: 0.3, gain: 0.25 });
        this.tone({ type: 'triangle', f0: 990, f1: 1980, dur: 0.3, gain: 0.18, delay: 0.1 });
        break;
      case 'fanfare':
        [392, 523, 659, 784].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.5, gain: 0.26, delay: i * 0.14, attack: 0.02 }));
        this.tone({ type: 'sawtooth', f0: 196, dur: 1.2, gain: 0.14, delay: 0.42, attack: 0.05 });
        break;
      default:
        break;
    }
  }

  /* --------------------------- music: a 4-bar driving loop --------------------------- */

  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.musicTimer = setInterval(() => this.schedule(), 90);
  }

  schedule() {
    const ctx = this.ctx;
    const stepDur = 60 / 118 / 4;
    // after a stall, skip the steps that are already in the past instead of firing them all at once
    if (this.nextTime < ctx.currentTime) {
      const missed = Math.ceil((ctx.currentTime - this.nextTime) / stepDur);
      this.step = (this.step + missed) % 64;
      this.nextTime += missed * stepDur;
    }
    while (this.nextTime < ctx.currentTime + 0.25) {
      this.playStep(this.step, this.nextTime - ctx.currentTime, stepDur);
      this.step = (this.step + 1) % 64;
      this.nextTime += stepDur;
    }
  }

  playStep(step, delay, stepDur) {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const out = this.music;
    const d = Math.max(0, delay);
    if (s === 0 || s === 6 || s === 8 || s === 14) this.tone({ f0: 120, f1: 44, dur: 0.24, gain: 0.9, delay: d, out });
    if (s === 4 || s === 12) this.noise({ dur: 0.13, f0: 2600, type: 'highpass', gain: 0.22, delay: d, out });
    if (s % 2 === 1) this.noise({ dur: 0.03, f0: 8000, type: 'highpass', gain: 0.06, delay: d, out });
    const roots = [73.42, 73.42, 58.27, 65.41];
    const root = roots[bar];
    if (s % 2 === 0) {
      const f = s === 10 ? root * 1.5 : s === 14 ? root * 1.2 : root;
      this.tone({ type: 'sawtooth', f0: f, dur: stepDur * 1.7, gain: 0.26, delay: d, out });
    }
    if (s === 0) {
      const chords = [[146.83, 174.61, 220], [146.83, 174.61, 220], [116.54, 146.83, 174.61], [130.81, 164.81, 196]];
      for (const f of chords[bar]) this.tone({ type: 'triangle', f0: f * 2, dur: stepDur * 15, gain: 0.07, attack: 0.3, delay: d, out });
    }
  }
}
