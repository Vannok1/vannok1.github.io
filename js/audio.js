// Procedural sound (no audio files): carbonation fizz built from thousands of tiny bubble
// "pops" (damped sine pings, Minnaert resonance), pouring = band-passed turbulent noise,
// gulps = throat thump + rising bubble chirp, and a (polite) burp at the end.

function rngNoise(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.ready = false;
    this.lastGulp = 0;
    this.gulps = 0;
    this.burps = 0;
  }

  /** Call inside a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      return;
    }
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.enabled ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    // --- fizz -------------------------------------------------------------------------
    const sr = ctx.sampleRate;
    const fizzLen = Math.floor(sr * 3);
    const fizzBuf = ctx.createBuffer(1, fizzLen, sr);
    const fd = fizzBuf.getChannelData(0);
    const pops = 2600;
    for (let k = 0; k < pops; k++) {
      const start = Math.floor(Math.random() * fizzLen);
      // Minnaert: f ≈ 3.3 / r(m) Hz → bubbles of 0.3–1.5 mm sing at 2–11 kHz
      const f = 2200 + Math.random() * Math.random() * 9000;
      const dur = Math.floor(sr * (0.0015 + Math.random() * 0.004));
      const amp = Math.pow(Math.random(), 3) * 0.5;
      const ph = Math.random() * 6.28;
      for (let i = 0; i < dur; i++) {
        const j = (start + i) % fizzLen;
        const env = Math.exp((-6 * i) / dur) * Math.min(1, i / 6);
        fd[j] += amp * env * Math.sin(ph + (2 * Math.PI * f * i) / sr);
      }
    }
    const hiss = rngNoise(fizzLen);
    for (let i = 0; i < fizzLen; i++) fd[i] += hiss[i] * 0.006;
    const fizz = ctx.createBufferSource();
    fizz.buffer = fizzBuf;
    fizz.loop = true;
    const fizzHP = ctx.createBiquadFilter();
    fizzHP.type = 'highpass';
    fizzHP.frequency.value = 1400;
    this.fizzGain = ctx.createGain();
    this.fizzGain.gain.value = 0;
    fizz.connect(fizzHP).connect(this.fizzGain).connect(master);
    fizz.start();

    // --- pour -------------------------------------------------------------------------
    const pourLen = Math.floor(sr * 2.5);
    const pourBuf = ctx.createBuffer(1, pourLen, sr);
    const pd = pourBuf.getChannelData(0);
    const pn = rngNoise(pourLen);
    let env = 0.6;
    for (let i = 0; i < pourLen; i++) {
      if (i % 220 === 0) env = 0.55 + 0.45 * Math.random();
      pd[i] = pn[i] * env;
    }
    // blub-blub of air entering the liquid
    for (let k = 0; k < 90; k++) {
      const start = Math.floor(Math.random() * pourLen);
      const f0 = 260 + Math.random() * 500;
      const dur = Math.floor(sr * (0.02 + Math.random() * 0.04));
      for (let i = 0; i < dur; i++) {
        const t = i / sr;
        const f = f0 * (1 + 2.5 * (i / dur));
        pd[(start + i) % pourLen] += 0.5 * Math.exp((-5 * i) / dur) * Math.sin(2 * Math.PI * f * t);
      }
    }
    const pour = ctx.createBufferSource();
    pour.buffer = pourBuf;
    pour.loop = true;
    const pourBP = ctx.createBiquadFilter();
    pourBP.type = 'bandpass';
    pourBP.frequency.value = 900;
    pourBP.Q.value = 0.7;
    const pourLP = ctx.createBiquadFilter();
    pourLP.type = 'lowpass';
    pourLP.frequency.value = 3500;
    this.pourGain = ctx.createGain();
    this.pourGain.gain.value = 0;
    this.pourBP = pourBP;
    pour.connect(pourBP).connect(pourLP).connect(this.pourGain).connect(master);
    pour.start();

    this.noiseBuf = ctx.createBuffer(1, sr, sr);
    this.noiseBuf.copyToChannel(rngNoise(sr), 0);
    this.ready = true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(on ? 0.9 : 0, t, 0.05);
    }
    if (on) this.init();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** Continuous layers, called every frame. */
  update({ fizz = 0, pour = 0, pourFill = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.fizzGain.gain.setTargetAtTime(Math.min(0.5, fizz), t, 0.08);
    this.pourGain.gain.setTargetAtTime(Math.min(0.55, pour * 0.55), t, 0.06);
    // the cavity resonance rises as the glass fills up
    this.pourBP.frequency.setTargetAtTime(700 + 1300 * pourFill, t, 0.1);
  }

  gulp(intensity = 1) {
    this.gulps++;
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const out = ctx.createGain();
    out.gain.value = 0.6 * Math.min(1, 0.4 + intensity);
    out.connect(this.master);
    // throat thump
    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.setValueAtTime(115 + Math.random() * 20, t);
    o1.frequency.exponentialRampToValueAtTime(62, t + 0.13);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(0.9, t + 0.012);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o1.connect(g1).connect(out);
    o1.start(t);
    o1.stop(t + 0.18);
    // liquid "glk": a bubble whose pitch rises as it closes
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    const f0 = 280 + Math.random() * 120;
    o2.frequency.setValueAtTime(f0, t + 0.02);
    o2.frequency.exponentialRampToValueAtTime(f0 * 2.4, t + 0.08);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.35, t + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o2.connect(g2).connect(out);
    o2.start(t + 0.02);
    o2.stop(t + 0.12);
    // wet noise
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 1.2;
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(0.0001, t);
    g3.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    n.connect(bp).connect(g3).connect(out);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.13);
    setTimeout(() => out.disconnect(), 400);
  }

  burp() {
    this.burps++;
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const dur = 0.55 + Math.random() * 0.25;
    const out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(this.master);
    // glottal pulse train with an irregular, falling pitch (vocal fry)
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    const f = 88 + Math.random() * 18;
    src.frequency.setValueAtTime(f * 1.15, t);
    src.frequency.linearRampToValueAtTime(f, t + 0.12);
    src.frequency.linearRampToValueAtTime(f * 0.78, t + dur);
    const jitter = ctx.createBufferSource();
    jitter.buffer = this.noiseBuf;
    const jg = ctx.createGain();
    jg.gain.value = 14;
    const jlp = ctx.createBiquadFilter();
    jlp.type = 'lowpass';
    jlp.frequency.value = 40;
    jitter.connect(jlp).connect(jg).connect(src.frequency);
    // amplitude rattle
    const am = ctx.createGain();
    am.gain.value = 0.6;
    const rattle = ctx.createOscillator();
    rattle.frequency.value = 31;
    const rg = ctx.createGain();
    rg.gain.value = 0.4;
    rattle.connect(rg).connect(am.gain);
    // vocal tract formants for an "oaw" vowel
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 480;
    f1.Q.value = 3;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 900;
    f2.Q.value = 4;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1.0, t + 0.05);
    env.gain.setValueAtTime(1.0, t + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(am);
    am.connect(f1).connect(lp);
    am.connect(f2).connect(f2g).connect(lp);
    lp.connect(env).connect(out);
    src.start(t);
    rattle.start(t);
    jitter.start(t);
    src.stop(t + dur + 0.05);
    rattle.stop(t + dur + 0.05);
    jitter.stop(t + dur + 0.05);
    setTimeout(() => out.disconnect(), (dur + 0.5) * 1000);
  }
}
