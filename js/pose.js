import { GUARD, POSES, clonePose, lerpPose, mid } from './moves.js';

const MP_VERSION = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

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

/** Webcam + MediaPipe pose landmarker. Produces mirrored pixel-space landmarks. */
export class PoseTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.px = null;          // smoothed pixel landmarks { name: {x, y, v} }
    this.lastSeen = 0;
    this.ready = false;
  }

  async init(onStatus) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot access the camera. Use Chrome or Edge, and open the game from http://localhost (see README).');
    }
    if (!this.video.srcObject) {
      onStatus?.('Starting camera…', 'Allow camera access when your browser asks.');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.video.srcObject = stream;
      await this.video.play();
    }
    if (!this.landmarker) {
      onStatus?.('Loading motion tracking…', 'Downloading the pose model (first time only takes a few seconds).');
      const { PoseLandmarker, FilesetResolver } = await import(`${MP_URL}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
      } catch (e) {
        console.warn('GPU delegate failed, falling back to CPU', e);
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
      }
    }
    this.ready = true;
  }

  get width() { return this.video.videoWidth || 640; }
  get height() { return this.video.videoHeight || 480; }

  /** Run detection on the newest video frame. Returns smoothed pixel landmarks or null. */
  update(now) {
    if (!this.ready || this.video.readyState < 2) return this.px;
    if (this.video.currentTime === this.lastVideoTime) return this.px;
    this.lastVideoTime = this.video.currentTime;

    const res = this.landmarker.detectForVideo(this.video, now);
    const lm = res.landmarks?.[0];
    if (!lm) {
      if (now - this.lastSeen > 400) this.px = null;
      return this.px;
    }
    this.lastSeen = now;
    const W = this.width, H = this.height;
    const a = 0.65; // smoothing (higher = more responsive)
    const next = {};
    for (const name of NAMES) {
      const p = lm[IDX[name]];
      const x = (1 - p.x) * W; // mirror
      const y = p.y * H;
      const v = p.visibility ?? 1;
      const prev = this.px?.[name];
      next[name] = prev
        ? { x: prev.x + (x - prev.x) * a, y: prev.y + (y - prev.y) * a, v }
        : { x, y, v };
    }
    this.px = next;
    return next;
  }

  stop() {
    const s = this.video.srcObject;
    if (s) s.getTracks().forEach(t => t.stop());
    this.video.srcObject = null;
    this.ready = false;
  }
}

/** Converts pixel landmarks to body space using a calibration. */
export function toBody(px, calib, minVis = 0.35) {
  if (!px || !calib) return null;
  const out = {};
  for (const name of NAMES) {
    const p = px[name];
    if (p && p.v >= minVis) out[name] = [(p.x - calib.cx) / calib.sw, -(p.y - calib.cy) / calib.sw];
  }
  return out.lSh && out.rSh ? out : null;
}

/**
 * Collects ~1.5 s of steady frames with the whole body visible and derives
 * the body-space origin/scale plus baseline knee heights.
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

    // Must be holding still
    const f0 = this.frames[0];
    if (f0 && Math.hypot(cx - f0.cx, cy - f0.cy) > f0.sw * 0.35) {
      this.message = 'Hold still…';
      this.frames = [];
    }
    this.message = 'Hold still… calibrating';
    this.frames.push({ cx, cy, sw, kl: px.lKn.y, kr: px.rKn.y });
    if (this.frames.length < 45) return null;

    const avg = k => this.frames.reduce((s, f) => s + f[k], 0) / this.frames.length;
    const c = { cx: avg('cx'), cy: avg('cy'), sw: avg('sw') };
    c.kneeL = -(avg('kl') - c.cy) / c.sw;
    c.kneeR = -(avg('kr') - c.cy) / c.sw;
    return c;
  }
}

/** Keyboard stand-in for the camera: keys snap a virtual body into move poses. */
export class VirtualBody {
  constructor() {
    this.pose = clonePose(GUARD);
    this.active = null;
    this.until = 0;
    this.held = new Set();
    this.keymap = {
      KeyA: 'PL', KeyD: 'PR', KeyQ: 'HL', KeyE: 'HR', KeyZ: 'KL', KeyC: 'KR',
      KeyW: 'UP', KeyS: 'DUCK', Space: 'JUMP', ArrowLeft: 'DL', ArrowRight: 'DR',
    };
    this.base = { kneeL: GUARD.lKn[1], kneeR: GUARD.rKn[1] };
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

/** Draws the tracked skeleton on the webcam preview. */
export function drawCamSkeleton(canvas, px, w, h) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!px) return;
  g.lineCap = 'round';
  g.lineWidth = 5;
  g.strokeStyle = '#00f0ff';
  g.shadowColor = '#00f0ff';
  g.shadowBlur = 10;
  for (const [a, b] of BONES) {
    const p = px[a], q = px[b];
    if (!p || !q || p.v < 0.35 || q.v < 0.35) continue;
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
  }
  g.fillStyle = '#ff2bd6';
  g.shadowColor = '#ff2bd6';
  for (const n of ['lWr', 'rWr', 'nose']) {
    const p = px[n];
    if (!p || p.v < 0.35) continue;
    g.beginPath(); g.arc(p.x, p.y, n === 'nose' ? 10 : 8, 0, Math.PI * 2); g.fill();
  }
}

export { mid };
