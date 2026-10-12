// Procedural synthwave music + sound effects, all generated with the Web Audio API.
// Because we generate the music ourselves, every beat time is known exactly.

export const TRACKS = [
  {
    id: 'warmup', name: 'Neon Warm-Up', bpm: 96, bpmEnd: 136, bars: 64, diff: 'ramp', color: '#00f0ff',
    desc: 'Starts slow, gets faster and faster!',
    chords: [
      { root: 45, notes: [57, 60, 64] }, // Am
      { root: 41, notes: [57, 60, 65] }, // F
      { root: 48, notes: [55, 60, 64] }, // C
      { root: 43, notes: [55, 59, 62] }, // G
    ],
  },
];

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

/** Constant-tempo map (used for your own songs). */
export function linearTempo(bpm, offset = 0) {
  const spb = 60 / bpm;
  return {
    timeOf: beat => offset + beat * spb,
    beatAt: t => (t - offset) / spb,
    bpmAt: () => bpm,
  };
}

/** Tempo map from per-bar durations (the music speeds up bar by bar). */
function barTempo(barStart, barDur) {
  const last = barDur.length - 1;
  const barAtTime = t => {
    let lo = 0, hi = last;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (barStart[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  };
  return {
    timeOf: beat => {
      const bar = Math.max(0, Math.min(last, Math.floor(beat / 4)));
      return barStart[bar] + ((beat - bar * 4) * barDur[bar]) / 4;
    },
    beatAt: t => {
      if (t < 0) return (t / barDur[0]) * 4;
      const bar = barAtTime(t);
      return bar * 4 + ((t - barStart[bar]) / barDur[bar]) * 4;
    },
    bpmAt: t => 240 / barDur[barAtTime(Math.max(0, t))],
  };
}

export class AudioEngine {
  constructor() {
    const c = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());

    this.master = c.createGain();
    this.master.gain.value = 0.85;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);

    this.music = c.createGain();
    this.music.connect(this.master);
    this.sfx = c.createGain();
    this.sfx.gain.value = 0.55;
    this.sfx.connect(this.master);

    // Bus for pads / arps that "pumps" with the kick (fake sidechain).
    this.pumpBus = c.createGain();
    this.pumpBus.connect(this.music);

    // Reverb
    this.reverb = c.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.4);
    const revOut = c.createGain();
    revOut.gain.value = 0.32;
    this.reverb.connect(revOut).connect(this.music);

    // Dotted-eighth delay (classic synthwave)
    this.delay = c.createDelay(2);
    const fb = c.createGain();
    fb.gain.value = 0.38;
    const delOut = c.createGain();
    delOut.gain.value = 0.28;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(delOut).connect(this.music);

    this.noise = this.makeNoise(1.5);
    this.timer = null;
    this.source = null;
    this.startAt = 0;
    this.duration = 0;
  }

  makeNoise(sec) {
    const c = this.ctx;
    const buf = c.createBuffer(1, c.sampleRate * sec, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  makeImpulse(sec) {
    const c = this.ctx;
    const len = c.sampleRate * sec;
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    return buf;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Song time in seconds (0 = first beat), compensated for output latency. */
  songTime() {
    return this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.startAt;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.source) {
      try { this.source.stop(); } catch (e) { /* already stopped */ }
      this.source = null;
    }
    const g = this.music.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 0.15);
    g.setValueAtTime(1, t + 0.4);
  }

  // ---------------- Synth song ----------------

  playSynth(track) {
    this.stop();
    this.track = track;
    // Tempo rises smoothly from bpm to bpmEnd, bar by bar (intro/outro stay put).
    const end = track.bpmEnd ?? track.bpm;
    this.barStart = [];
    this.barDur = [];
    let t = 0;
    for (let b = 0; b < track.bars; b++) {
      const k = Math.min(1, Math.max(0, (b - 2) / (track.bars - 8)));
      const bpm = track.bpm + (end - track.bpm) * k;
      this.barStart.push(t);
      this.barDur.push(240 / bpm);
      t += 240 / bpm;
    }
    this.tempo = barTempo(this.barStart, this.barDur);
    this.spb = this.barDur[0] / 4;
    this.stepDur = this.spb / 4;
    this.step = 0;
    this.totalSteps = track.bars * 16;
    this.startAt = this.ctx.currentTime + 0.5;
    this.duration = t;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  async decode(file) {
    const data = await file.arrayBuffer();
    return await this.ctx.decodeAudioData(data);
  }

  playBuffer(buffer) {
    this.stop();
    this.track = null;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.music);
    this.startAt = this.ctx.currentTime + 0.5;
    src.start(this.startAt);
    this.source = src;
    this.duration = buffer.duration;
    this.tempo = null;
  }

  schedule() {
    const ahead = this.ctx.currentTime + 0.15;
    while (this.step < this.totalSteps) {
      const bar = Math.floor(this.step / 16);
      const t = this.startAt + this.barStart[bar] + ((this.step % 16) * this.barDur[bar]) / 16;
      if (t > ahead) break;
      this.playStep(this.step, t);
      this.step++;
    }
    if (this.step >= this.totalSteps) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  playStep(s, t) {
    const tr = this.track;
    const bar = Math.floor(s / 16);
    const st = s % 16;
    this.spb = this.barDur[bar] / 4;
    this.stepDur = this.spb / 4;
    const chord = tr.chords[bar % tr.chords.length];
    const intro = bar < 2;
    const outro = bar >= tr.bars - 2;
    const secBar = (bar - 2) % 8;
    const barDur = this.spb * 4;

    if (st === 0) this.pad(t, chord.notes, barDur);

    if (intro) {
      if (st % 2 === 0) this.hat(t, false, 0.35);
      if (bar === 1 && st % 4 === 0) this.click(t, st === 12);
      return;
    }

    if (outro) {
      if (bar === tr.bars - 2 && st === 0) { this.kick(t); this.crash(t); this.bass(t, chord.root, barDur * 2); }
      return;
    }

    // Drums
    if (st % 4 === 0) this.kick(t);
    if (st === 4 || st === 12) this.snare(t, 1);
    if (st % 4 === 2) this.hat(t, true, 0.9);
    else if (tr.hats16 || st % 2 === 0) this.hat(t, false, 0.5);
    if (secBar === 7 && st >= 12) this.snare(t, 0.45 + (st - 12) * 0.15); // fill
    if (secBar === 0 && st === 0 && bar > 2) this.crash(t);

    // Bass: driving octave eighths
    if (st % 2 === 0) this.bass(t, chord.root + (st % 4 === 2 ? 12 : 0), this.stepDur * 1.7);

    // Arpeggio from bar 6
    if (bar >= 6) {
      const seq = [0, 1, 2, 1, 2, 0, 2, 1];
      const n = chord.notes[seq[st % 8]] + 12;
      this.arp(t, n);
    }
  }

  // ---------------- Instruments ----------------

  env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  kick(t) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this.env(g, t, 1.0, 0.002, 0.42);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.5);
    // sidechain pump
    const pg = this.pumpBus.gain;
    pg.setValueAtTime(0.25, t);
    pg.linearRampToValueAtTime(1, t + this.spb * 0.85);
  }

  snare(t, vol) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const g = c.createGain();
    this.env(g, t, 0.55 * vol, 0.002, 0.2);
    n.connect(hp).connect(g);
    g.connect(this.music);
    g.connect(this.reverb);
    n.start(t);
    n.stop(t + 0.3);

    const o = c.createOscillator();
    const og = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.1);
    this.env(og, t, 0.4 * vol, 0.002, 0.12);
    o.connect(og).connect(this.music);
    o.start(t);
    o.stop(t + 0.2);
  }

  hat(t, open, vol) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = c.createGain();
    this.env(g, t, 0.16 * vol, 0.001, open ? 0.14 : 0.04);
    n.connect(hp).connect(g).connect(this.music);
    n.start(t, Math.random());
    n.stop(t + 0.2);
  }

  crash(t) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000;
    const g = c.createGain();
    this.env(g, t, 0.22, 0.003, 1.4);
    n.connect(hp).connect(g);
    g.connect(this.music);
    g.connect(this.reverb);
    n.start(t);
    n.stop(t + 1.5);
  }

  bass(t, midi, dur) {
    const c = this.ctx;
    const o = c.createOscillator();
    const o2 = c.createOscillator();
    o.type = 'sawtooth';
    o2.type = 'square';
    o.frequency.value = mtof(midi);
    o2.frequency.value = mtof(midi - 12);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 5;
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    const g = c.createGain();
    this.env(g, t, 0.32, 0.004, dur);
    const g2 = c.createGain();
    g2.gain.value = 0.35;
    o.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(g).connect(this.music);
    o.start(t); o2.start(t);
    o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }

  pad(t, notes, dur) {
    const c = this.ctx;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.3);
    g.gain.setValueAtTime(0.11, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.5);
    lp.connect(g);
    g.connect(this.pumpBus);
    g.connect(this.reverb);
    for (const n of notes) {
      for (const det of [-9, 9]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n);
        o.detune.value = det;
        const og = c.createGain();
        og.gain.value = 0.33;
        o.connect(og).connect(lp);
        o.start(t);
        o.stop(t + dur + 0.6);
      }
    }
  }

  arp(t, midi) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = mtof(midi);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.15);
    const g = c.createGain();
    this.env(g, t, 0.07, 0.003, 0.16);
    o.connect(lp).connect(g);
    g.connect(this.pumpBus);
    g.connect(this.delay);
    this.delay.delayTime.setValueAtTime(this.spb * 0.75, t);
    o.start(t);
    o.stop(t + 0.25);
  }

  click(t, high) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = high ? 1760 : 1175;
    const g = c.createGain();
    this.env(g, t, 0.3, 0.002, 0.12);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.15);
  }

  // ---------------- Sound effects ----------------

  sfxHit(grade) {
    const c = this.ctx;
    const t = c.currentTime;
    const base = grade === 'perfect' ? 88 : grade === 'great' ? 84 : 79;
    [0, 7, 12].forEach((iv, i) => {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = mtof(base + iv);
      const g = c.createGain();
      this.env(g, t + i * 0.025, 0.18, 0.002, 0.18);
      o.connect(g).connect(this.sfx);
      g.connect(this.reverb);
      o.start(t + i * 0.025);
      o.stop(t + i * 0.025 + 0.25);
    });
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    const ng = c.createGain();
    this.env(ng, t, 0.35, 0.001, 0.07);
    n.connect(bp).connect(ng).connect(this.sfx);
    n.start(t);
    n.stop(t + 0.1);
  }

  sfxMiss() {
    const c = this.ctx;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.25);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = c.createGain();
    this.env(g, t, 0.22, 0.003, 0.25);
    o.connect(lp).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.3);
  }

  /** Rising whoosh for "speed up!" */
  sfxWhoosh() {
    const c = this.ctx;
    const t = c.currentTime;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(5000, t + 0.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    n.connect(bp).connect(g).connect(this.sfx);
    n.start(t);
    n.stop(t + 0.85);
    [0, 4, 7, 12].forEach((iv, i) => {
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = mtof(72 + iv);
      const og = c.createGain();
      this.env(og, t + 0.3 + i * 0.07, 0.08, 0.003, 0.12);
      o.connect(og).connect(this.sfx);
      o.start(t + 0.3 + i * 0.07);
      o.stop(t + 0.5 + i * 0.07);
    });
  }

  sfxUi() {
    const c = this.ctx;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(660, t);
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
    const g = c.createGain();
    this.env(g, t, 0.15, 0.002, 0.12);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.15);
  }
}
