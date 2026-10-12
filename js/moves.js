// Body space: origin = player's shoulder midpoint (measured at calibration),
// 1 unit = calibrated shoulder width, +x = screen right, +y = up.
// "l" / "r" always mean screen-left / screen-right (the view is mirrored).

export const MOVES = {
  PL:   { kind: 'hand', label: 'PUNCH', pos: [-1.75, 0.1], radius: 0.75, color: 0x00f0ff, arrow: Math.PI },
  PR:   { kind: 'hand', label: 'PUNCH', pos: [1.75, 0.1], radius: 0.75, color: 0xff2bd6, arrow: 0 },
  HL:   { kind: 'hand', label: 'HIGH', pos: [-1.3, 1.55], radius: 0.75, color: 0x4dd2ff, arrow: Math.PI * 0.75 },
  HR:   { kind: 'hand', label: 'HIGH', pos: [1.3, 1.55], radius: 0.75, color: 0xff6ad5, arrow: Math.PI * 0.25 },
  KL:   { kind: 'knee', label: 'KNEE', side: -1, pos: [-0.45, -1.5], color: 0x39ff88, arrow: Math.PI / 2 },
  KR:   { kind: 'knee', label: 'KNEE', side: 1, pos: [0.45, -1.5], color: 0x39ff88, arrow: Math.PI / 2 },
  UP:   { kind: 'up', label: 'REACH UP', color: 0xffd23f },
  DUCK: { kind: 'duck', label: 'DUCK', color: 0xff3355 },
  JUMP: { kind: 'jump', label: 'JUMP', color: 0xa070ff },
  DL:   { kind: 'dodge', label: 'STEP', side: -1, color: 0xff7a1a },
  DR:   { kind: 'dodge', label: 'STEP', side: 1, color: 0xff7a1a },
};

export const COACH_TEXT = {
  PL: 'PUNCH ◀', PR: 'PUNCH ▶', HL: 'HIGH ◀', HR: 'HIGH ▶',
  KL: 'LEFT KNEE', KR: 'RIGHT KNEE', UP: 'REACH UP', DUCK: 'DUCK!',
  JUMP: 'JUMP!', DL: '◀ STEP', DR: 'STEP ▶',
};

// ---------- Reference poses (used by the coach and keyboard mode) ----------

export const GUARD = {
  nose: [0, 0.95],
  lSh: [-0.5, 0], rSh: [0.5, 0],
  lEl: [-0.75, -0.6], rEl: [0.75, -0.6],
  lWr: [-0.35, 0.25], rWr: [0.35, 0.25],
  lHip: [-0.33, -1.3], rHip: [0.33, -1.3],
  lKn: [-0.36, -2.4], rKn: [0.36, -2.4],
  lAn: [-0.38, -3.4], rAn: [0.38, -3.4],
};

const UPPER = ['nose', 'lSh', 'rSh', 'lEl', 'rEl', 'lWr', 'rWr'];

function clonePose(p) {
  const o = {};
  for (const k in p) o[k] = [p[k][0], p[k][1]];
  return o;
}

function mirrorPose(p) {
  const o = {};
  for (const k in p) {
    const mk = k[0] === 'l' ? 'r' + k.slice(1) : k[0] === 'r' ? 'l' + k.slice(1) : k;
    o[mk] = [-p[k][0], p[k][1]];
  }
  return o;
}

function shift(p, dx, dy, keys = Object.keys(p)) {
  for (const k of keys) { p[k][0] += dx; p[k][1] += dy; }
  return p;
}

function build() {
  const P = {};
  P.PL = Object.assign(clonePose(GUARD), { lEl: [-1.05, 0.08], lWr: [-1.8, 0.12] });
  P.PR = mirrorPose(P.PL);
  P.HL = Object.assign(clonePose(GUARD), { lEl: [-0.95, 0.75], lWr: [-1.35, 1.55] });
  P.HR = mirrorPose(P.HL);
  P.KL = Object.assign(clonePose(GUARD), { lKn: [-0.45, -1.45], lAn: [-0.5, -2.45], lWr: [-0.45, -0.7], lEl: [-0.85, -0.2] });
  P.KR = mirrorPose(P.KL);
  P.UP = Object.assign(clonePose(GUARD), { lEl: [-0.7, 0.95], lWr: [-0.55, 2.0], rEl: [0.7, 0.95], rWr: [0.55, 2.0] });
  P.DUCK = shift(clonePose(GUARD), 0, -0.95, UPPER);
  Object.assign(P.DUCK, { lHip: [-0.38, -2.15], rHip: [0.38, -2.15], lKn: [-0.8, -2.65], rKn: [0.8, -2.65] });
  P.JUMP = shift(clonePose(GUARD), 0, 0.65);
  Object.assign(P.JUMP, {
    lKn: [-0.42, -1.6], rKn: [0.42, -1.6], lAn: [-0.4, -2.5], rAn: [0.4, -2.5],
    lEl: [-0.75, 0.05], rEl: [0.75, 0.05], lWr: [-0.8, -0.6], rWr: [0.8, -0.6],
  });
  P.DL = shift(clonePose(GUARD), -1.15, 0);
  P.DR = shift(clonePose(GUARD), 1.15, 0);
  return P;
}

export const POSES = build();

export function lerpPose(out, target, a) {
  for (const k in target) {
    out[k][0] += (target[k][0] - out[k][0]) * a;
    out[k][1] += (target[k][1] - out[k][1]) * a;
  }
  return out;
}

export { clonePose };

// ---------- Hit conditions ----------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Is the body currently performing `moveId`?
 * body: pose dict in body space (points may be missing if not visible).
 * base: baseline values from calibration { kneeL, kneeR }.
 */
export function checkMove(moveId, body, base) {
  const m = MOVES[moveId];
  const p = body;
  switch (m.kind) {
    case 'hand': {
      return [p.lWr, p.rWr].some(w => w && dist(w, m.pos) < m.radius);
    }
    case 'knee': {
      const knee = m.side < 0 ? p.lKn : p.rKn;
      const ref = m.side < 0 ? base.kneeL : base.kneeR;
      const s = mid(p.lSh, p.rSh);
      // shoulders must stay roughly level, otherwise it's a jump, not a knee raise
      return !!knee && knee[1] > ref + 0.7 && (!s || s[1] < 0.3);
    }
    case 'up': {
      if (!p.lWr || !p.rWr) return false;
      const need = Math.max(1.2, (p.nose ? p.nose[1] : 0.95) + 0.2);
      return p.lWr[1] > need && p.rWr[1] > need;
    }
    case 'duck': {
      const s = mid(p.lSh, p.rSh);
      return !!s && s[1] < -0.65;
    }
    case 'jump': {
      const s = mid(p.lSh, p.rSh);
      return !!s && s[1] > 0.35;
    }
    case 'dodge': {
      const s = mid(p.lSh, p.rSh);
      return !!s && s[0] * m.side > 0.8;
    }
  }
  return false;
}

export function mid(a, b) {
  if (!a || !b) return null;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
