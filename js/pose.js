import { GUARD, POSES, clonePose, lerpPose, mid } from './moves.js';

const MP_VERSION = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
// "full" is noticeably more accurate than "lite" and still runs in real time on most laptops.
const MODEL_URLS = {
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

// MediaPipe landmark indices. The view is mirrored, so the person's left side
// appears on the screen's left: "l" = screen-left = person's left.
const IDX = {
  nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28,
};
const NAMES = Object.keys(IDX);

export const BONES = [
  ['lSh', 'rSh'], ['lSh', 'lEl'], ['lEl', 'lWr'], ['rSh', 'rEl'], ['rEl', 'rWr'],
  ['lSh', 'lHip'], ['rSh', 'rHip'], ['lHip', 'rHip'],
  ['lHip', 'lKn'], ['lKn', 'lAn'], ['rHip', 'rKn'], ['rKn', 'rAn'],
];

/**
 * One-Euro filter: heavy smoothing when a point is still (no jitter),
 * light smoothing when it moves fast (no lag on punches).
 */
class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.012, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, dt) {
    if (this.x == null || dt <= 0) { this.x = x; return x; }
    const dx = (x - this.x) / dt;
    this.dx += (dx - this.dx) * OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (x - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
}

/** Webcam + MediaPipe pose landmarker. Produces filtered, mirrored pixel-space landmarks. */
export class PoseTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;   // main-thread fallback
    this.worker = null;       // preferred: detection in a background thread
    this.busy = false;
    this.lastVideoTime = -1;
    this.lastStamp = 0;
    this.ready = false;
    this.numPlayers = 1;
    // One slot per player: slot 0 = left side of the screen, slot 1 = right side.
    this.slots = [0, 1].map(() => this.newSlot());
    this.fps = 0;
    this.latency = 0.05;      // measured: frame grabbed -> landmarks ready (s)
  }

  async init(onStatus) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot access the camera. Use Chrome or Edge, and open the game from http://localhost or the GitHub Pages link.');
    }
    if (!this.video.srcObject) {
      onStatus?.('Starting camera…', 'Allow camera access when your browser asks.');
      let stream;
      try {
        // "ideal" values are preferences, never hard requirements, so any webcam works
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 60 }, facingMode: 'user' },
          audio: false,
        });
      } catch (e) {
        if (e?.name !== 'OverconstrainedError' && e?.name !== 'NotReadableError') throw e;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      this.video.srcObject = stream;
      await this.video.play();
    }
    if (!this.worker && !this.landmarker) {
      onStatus?.('Loading motion tracking…', 'Downloading the pose model. The first time takes a few seconds.');
      if (!(await this.startWorker())) await this.startMainThread();
    }
    this.ready = true;
  }

  startWorker() {
    if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') return Promise.resolve(false);
    return new Promise(resolve => {
      let w;
      try {
        w = new Worker(new URL('./pose-worker.js', import.meta.url));
      } catch (e) {
        console.warn('Pose worker unavailable', e);
        return resolve(false);
      }
      const fail = why => { console.warn('Pose worker failed, using main thread:', why); w.terminate(); resolve(false); };
      const timer = setTimeout(() => fail('timeout'), 30000);
      w.onerror = e => { clearTimeout(timer); fail(e.message); };
      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.worker = w;
          this.modelName = m.model + ' (worker)';
          w.onmessage = ev => this.onWorkerResult(ev.data);
          w.onerror = ev => console.warn('Pose worker error', ev.message);
          resolve(true);
        } else if (m.type === 'error') {
          clearTimeout(timer);
          fail(m.message);
        }
      };
      w.postMessage({ type: 'init', mpUrl: MP_URL, models: MODEL_URLS, numPoses: this.numPlayers });
    });
  }

  async startMainThread() {
    const { PoseLandmarker, FilesetResolver } = await import(`${MP_URL}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    const opts = (model, delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URLS[model], delegate },
      runningMode: 'VIDEO',
      numPoses: this.numPlayers,
      minPoseDetectionConfidence: 0.6,
      minPosePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    for (const [model, delegate] of [['full', 'GPU'], ['lite', 'GPU'], ['lite', 'CPU']]) {
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts(model, delegate));
        this.modelName = `${model}/${delegate}`;
        return;
      } catch (e) {
        console.warn(`Pose model ${model}/${delegate} failed`, e);
      }
    }
    throw new Error('Could not load the motion-tracking model. Check your internet connection.');
  }

  newSlot() {
    const filters = {};
    for (const n of NAMES) filters[n] = { x: new OneEuro(), y: new OneEuro() };
    return { px: null, lastSeen: 0, filters };
  }

  /** Track 1 or 2 people (2 = side-by-side versus mode). */
  setPlayers(n) {
    if (n === this.numPlayers) return;
    this.numPlayers = n;
    this.slots = [0, 1].map(() => this.newSlot());
    if (this.worker) this.worker.postMessage({ type: 'options', numPoses: n });
    else this.landmarker?.setOptions({ numPoses: n });
  }

  /** Filtered pixel landmarks of player 1 (solo mode). */
  get px() { return this.slots[0].px; }

  /** Filtered pixel landmarks of every player slot. */
  get pxAll() { return this.slots.slice(0, this.numPlayers).map(s => s.px); }

  get width() { return this.video.videoWidth || 640; }
  get height() { return this.video.videoHeight || 480; }

  /** Call every frame. Returns the latest filtered pixel landmarks (or null). */
  update(now) {
    if (!this.ready || this.video.readyState < 2) return this.px;
    if (this.video.currentTime === this.lastVideoTime) return this.px;

    if (this.worker) {
      if (this.busy) return this.px; // still working on the previous frame
      this.lastVideoTime = this.video.currentTime;
      this.busy = true;
      const ts = performance.now();
      createImageBitmap(this.video).then(bitmap => {
        this.worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]);
      }).catch(() => { this.busy = false; });
      return this.px;
    }

    this.lastVideoTime = this.video.currentTime;
    const res = this.landmarker.detectForVideo(this.video, now);
    this.ingest((res.landmarks || []).map(p => p.map(q => [q.x, q.y, q.visibility ?? 1])), now, now);
    return this.px;
  }

  onWorkerResult(m) {
    if (m.type !== 'result') return;
    this.busy = false;
    const now = performance.now();
    this.latency += ((now - m.ts) / 1000 - this.latency) * 0.1;
    this.ingest(m.lms, m.ts, now);
  }

  /** lms: list of people, each an array of [x, y, visibility] in MediaPipe order. */
  ingest(lms, ts, now) {
    const dt = this.lastStamp ? Math.max(1e-3, (ts - this.lastStamp) / 1000) : 1 / 30;
    this.lastStamp = ts;
    this.fps += (1 / dt - this.fps) * 0.1;

    // Which person goes to which slot? Use the (mirrored) shoulder centre.
    const cx = lm => 1 - (lm[IDX.lSh][0] + lm[IDX.rSh][0]) / 2;
    const people = (lms || []).filter(Boolean);
    const assign = [null, null];
    if (this.numPlayers === 1) {
      // solo: the person nearest the middle of the frame
      if (people.length) assign[0] = people.reduce((a, b) => (Math.abs(cx(a) - 0.5) <= Math.abs(cx(b) - 0.5) ? a : b));
    } else if (people.length >= 2) {
      const [a, b] = people.slice(0, 2).sort((p, q) => cx(p) - cx(q));
      assign[0] = a;
      assign[1] = b;
    } else if (people.length === 1) {
      // one person visible: give it to the slot they were last near (or by screen side)
      const x = cx(people[0]) * this.width;
      const d = i => {
        const px = this.slots[i].px;
        return px ? Math.abs((px.lSh.x + px.rSh.x) / 2 - x) : Infinity;
      };
      const i = d(0) === Infinity && d(1) === Infinity ? (x < this.width / 2 ? 0 : 1) : d(0) <= d(1) ? 0 : 1;
      assign[i] = people[0];
    }
    for (let i = 0; i < this.numPlayers; i++) this.ingestSlot(this.slots[i], assign[i], dt, now);
  }

  ingestSlot(slot, lm, dt, now) {
    if (!lm) {
      if (now - slot.lastSeen > 400) slot.px = null;
      return;
    }
    slot.lastSeen = now;
    const W = this.width, H = this.height;
    const next = {};
    for (const name of NAMES) {
      const [x, y, v] = lm[IDX[name]];
      const f = slot.filters[name];
      const prev = slot.px?.[name];
      if (v < 0.15 && prev) {
        // landmark lost for a moment (motion blur, out of frame): hold its last position
        next[name] = { x: prev.x, y: prev.y, v: prev.v * 0.8 };
        continue;
      }
      next[name] = { x: f.x.filter((1 - x) * W, dt), y: f.y.filter(y * H, dt), v };
    }
    slot.px = next;
  }

  stop() {
    const s = this.video.srcObject;
    if (s) s.getTracks().forEach(t => t.stop());
    this.video.srcObject = null;
    this.ready = false;
  }
}

/**
 * Converts pixel landmarks to body space.
 * Keeps the calibrated origin (so ducks, jumps and side-steps are measured
 * against where you stood) but continuously adapts the scale from torso
 * length, so stepping closer to or further from the camera doesn't break detection.
 */
export class BodyMapper {
  constructor(calib) {
    this.calib = calib;
    this.scale = calib.sw;
  }

  map(px) {
    const c = this.calib;
    if (!px) return null;
    const sh = px.lSh && px.rSh && px.lSh.v > 0.5 && px.rSh.v > 0.5 ? px : null;
    const hipOk = px.lHip && px.rHip && px.lHip.v > 0.5 && px.rHip.v > 0.5;
    if (sh && hipOk) {
      const torso = Math.hypot(
        (px.lSh.x + px.rSh.x - px.lHip.x - px.rHip.x) / 2,
        (px.lSh.y + px.rSh.y - px.lHip.y - px.rHip.y) / 2,
      );
      const target = Math.min(c.sw * 1.4, Math.max(c.sw * 0.7, torso / c.torsoRatio));
      this.scale += (target - this.scale) * 0.03; // slow: ignores leaning, follows walking
    }
    return toBody(px, { cx: c.cx, cy: c.cy, sw: this.scale });
  }
}

/** Plain conversion with a fixed origin/scale. */
export function toBody(px, calib) {
  if (!px || !calib) return null;
  const out = {};
  for (const name of NAMES) {
    const p = px[name];
    const minVis = name.endsWith('Wr') || name.endsWith('An') ? 0.2 : 0.35;
    if (p && p.v >= minVis) out[name] = [(p.x - calib.cx) / calib.sw, -(p.y - calib.cy) / calib.sw];
  }
  if (!out.lSh || !out.rSh) return null;
  // Fast punches blur the hand; estimate a missing wrist from a straight arm.
  for (const s of ['l', 'r']) {
    const sh = out[s + 'Sh'], el = out[s + 'El'];
    if (!out[s + 'Wr'] && sh && el) out[s + 'Wr'] = [el[0] * 2 - sh[0], el[1] * 2 - sh[1]];
  }
  return out;
}

/**
 * Collects ~1.5 s of steady frames with the whole body visible and derives
 * the body-space origin/scale plus baselines (knee, thigh, ankle heights).
 */
export class Calibrator {
  constructor() { this.reset(); }
  reset() { this.frames = []; this.message = ''; }

  get progress() { return Math.min(1, this.frames.length / 45); }

  /** Feed a frame. Returns a calibration object when done, else null. */
  add(px) {
    const need = ['nose', 'lSh', 'rSh', 'lHip', 'rHip', 'lKn', 'rKn'];
    if (!px) { this.message = 'Step in front of the camera'; this.frames = []; return null; }
    const missing = need.filter(n => !px[n] || px[n].v < 0.5);
    if (missing.length) {
      this.message = missing.some(n => n.endsWith('Kn') || n.endsWith('Hip'))
        ? 'Step back. Your knees need to be in view.'
        : 'Face the camera';
      this.frames = [];
      return null;
    }
    const cx = (px.lSh.x + px.rSh.x) / 2;
    const cy = (px.lSh.y + px.rSh.y) / 2;
    const sw = Math.hypot(px.lSh.x - px.rSh.x, px.lSh.y - px.rSh.y);
    if (sw < 25) { this.message = 'Come a little closer'; this.frames = []; return null; }

    const f0 = this.frames[0];
    if (f0 && Math.hypot(cx - f0.cx, cy - f0.cy) > f0.sw * 0.35) {
      this.message = 'Hold still…';
      this.frames = [];
      return null;
    }
    this.message = 'Hold still… calibrating';
    const hx = (px.lHip.x + px.rHip.x) / 2, hy = (px.lHip.y + px.rHip.y) / 2;
    const ankles = px.lAn?.v > 0.5 && px.rAn?.v > 0.5;
    this.frames.push({
      cx, cy, sw,
      torso: Math.hypot(cx - hx, cy - hy),
      kl: px.lKn.y, kr: px.rKn.y,
      tl: px.lKn.y - px.lHip.y, tr: px.rKn.y - px.rHip.y,
      an: ankles ? (px.lAn.y + px.rAn.y) / 2 : NaN,
    });
    if (this.frames.length < 45) return null;

    const avg = k => {
      const vals = this.frames.map(f => f[k]).filter(v => !Number.isNaN(v));
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : NaN;
    };
    const c = { cx: avg('cx'), cy: avg('cy'), sw: avg('sw') };
    c.torsoRatio = avg('torso') / c.sw;
    c.kneeL = -(avg('kl') - c.cy) / c.sw;
    c.kneeR = -(avg('kr') - c.cy) / c.sw;
    c.thighL = avg('tl') / c.sw;
    c.thighR = avg('tr') / c.sw;
    const an = avg('an');
    c.ankleY = Number.isNaN(an) ? null : -(an - c.cy) / c.sw;
    return c;
  }
}

export const KEYS_P1 = {
  KeyA: 'PL', KeyD: 'PR', KeyQ: 'HL', KeyE: 'HR', KeyZ: 'KL', KeyC: 'KR',
  KeyW: 'UP', KeyS: 'DUCK', Space: 'JUMP', ArrowLeft: 'DL', ArrowRight: 'DR',
};
export const KEYS_P2 = {
  KeyJ: 'PL', KeyL: 'PR', KeyU: 'HL', KeyO: 'HR', KeyM: 'KL', Period: 'KR',
  KeyI: 'UP', KeyK: 'DUCK', Enter: 'JUMP', KeyH: 'DL', Semicolon: 'DR',
};

/** Keyboard stand-in for the camera: keys snap a virtual body into move poses. */
export class VirtualBody {
  constructor(keymap = KEYS_P1) {
    this.pose = clonePose(GUARD);
    this.active = null;
    this.until = 0;
    this.held = new Set();
    this.keymap = keymap;
    this.base = {
      kneeL: GUARD.lKn[1], kneeR: GUARD.rKn[1],
      thighL: GUARD.lHip[1] - GUARD.lKn[1], thighR: GUARD.rHip[1] - GUARD.rKn[1],
      ankleY: (GUARD.lAn[1] + GUARD.rAn[1]) / 2,
    };
  }

  keydown(code, now) {
    const m = this.keymap[code];
    if (!m) return false;
    this.held.add(code);
    this.active = m;
    this.until = now + 280;
    return true;
  }

  keyup(code) { this.held.delete(code); }

  update(dt, now) {
    let target = GUARD;
    if (this.active && (now < this.until || [...this.held].some(c => this.keymap[c] === this.active))) {
      target = POSES[this.active];
    } else {
      this.active = null;
    }
    lerpPose(this.pose, target, 1 - Math.exp(-dt * 30));
    return this.pose;
  }
}

const CAM_COLORS = [['#00f0ff', '#ff2bd6'], ['#ff6ad5', '#ffd23f']];

/** Draws the tracked skeletons on the webcam preview (one colour per player). */
export function drawCamSkeleton(canvas, pxList, w, h) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (pxList.length > 1) {
    // divider between the two players' halves
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.setLineDash([10, 10]);
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
    g.setLineDash([]);
  }
  pxList.forEach((px, i) => {
    if (!px) return;
    const [line, dot] = CAM_COLORS[i];
    g.lineCap = 'round';
    g.lineWidth = 5;
    g.strokeStyle = line;
    g.shadowColor = line;
    g.shadowBlur = 10;
    for (const [a, b] of BONES) {
      const p = px[a], q = px[b];
      if (!p || !q || p.v < 0.35 || q.v < 0.35) continue;
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    }
    g.fillStyle = dot;
    g.shadowColor = dot;
    for (const n of ['lWr', 'rWr', 'nose']) {
      const p = px[n];
      if (!p || p.v < 0.35) continue;
      g.beginPath(); g.arc(p.x, p.y, n === 'nose' ? 10 : 8, 0, Math.PI * 2); g.fill();
    }
    g.shadowBlur = 0;
  });
}

export { mid };
