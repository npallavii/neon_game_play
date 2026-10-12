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
  const s = mid(p.lSh, p.rSh);
  if (!s) return false;
  switch (m.kind) {
    case 'hand': {
      // Targets are relative to where your shoulders are *now*, so drifting
      // a little to one side doesn't make punches miss.
      const target = [s[0] + m.pos[0], s[1] + m.pos[1]];
      for (const side of ['l', 'r']) {
        const w = p[side + 'Wr'], sh = p[side + 'Sh'];
        if (!w) continue;
        // 1) hand is near the target
        if (dist(w, target) < m.radius + 0.1) return true;
        // 2) arm is stretched out pointing at the target (works for any arm length)
        if (sh) {
          const v = [w[0] - sh[0], w[1] - sh[1]];
          const d = [target[0] - sh[0], target[1] - sh[1]];
          const lv = Math.hypot(...v), ld = Math.hypot(...d);
          const cos = (v[0] * d[0] + v[1] * d[1]) / (lv * ld || 1);
          // ...and the hand really is out to that side (so "reach up" doesn't count as a high punch)
          const sideways = (w[0] - s[0]) * Math.sign(m.pos[0]) > Math.abs(m.pos[0]) * 0.6;
          if (lv > ld * 0.65 && cos > 0.87 && sideways) return true; // within ~30°
        }
      }
      return false;
    }
    case 'knee': {
      if (s[1] > 0.3) return false; // that's a jump, not a knee raise
      const sd = m.side < 0 ? 'l' : 'r', od = m.side < 0 ? 'r' : 'l';
      const knee = p[sd + 'Kn'], hip = p[sd + 'Hip'];
      if (!knee) return false;
      // a) knee rose from its standing height
      const ref = sd === 'l' ? base.kneeL : base.kneeR;
      if (knee[1] > ref + 0.65) return true;
      // b) thigh lifted (knee came up close to hip height) while the other leg stays straight
      if (hip) {
        const thigh = sd === 'l' ? base.thighL : base.thighR;
        const lifted = hip[1] - knee[1] < thigh * 0.55;
        const oKnee = p[od + 'Kn'], oHip = p[od + 'Hip'];
        const oThigh = sd === 'l' ? base.thighR : base.thighL;
        const otherStraight = !oKnee || !oHip || oHip[1] - oKnee[1] > oThigh * 0.75;
        if (lifted && otherStraight) return true;
      }
      return false;
    }
    case 'up': {
      if (!p.lWr || !p.rWr) return false;
      const head = p.nose ? p.nose[1] : s[1] + 0.95;
      const need = Math.max(s[1] + 1.1, head + 0.1);
      return p.lWr[1] > need && p.rWr[1] > need;
    }
    case 'duck': {
      if (s[1] < -0.6) return true;
      // squat: both thighs fold (hips drop toward knees) and shoulders come down
      const t = thighFold(p, base);
      return t != null && t < 0.6 && s[1] < -0.3;
    }
    case 'jump': {
      if (s[1] > 0.32) return true;
      if (base.ankleY != null && p.lAn && p.rAn) {
        return (p.lAn[1] + p.rAn[1]) / 2 > base.ankleY + 0.3 && s[1] > 0.12;
      }
      return false;
    }
    case 'dodge': {
      const h = mid(p.lHip, p.rHip);
      const x = h ? (s[0] + h[0]) / 2 : s[0];
      return x * m.side > 0.7;
    }
  }
  return false;
}

/** Average thigh height relative to standing (1 = straight legs, ~0 = deep squat). */
function thighFold(p, base) {
  const r = [];
  if (p.lHip && p.lKn && base.thighL) r.push((p.lHip[1] - p.lKn[1]) / base.thighL);
  if (p.rHip && p.rKn && base.thighR) r.push((p.rHip[1] - p.rKn[1]) / base.thighR);
  return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
}

/** All moves the body is doing right now (for the live "detected" indicator). */
export function detectAll(body, base) {
  if (!body) return [];
  return Object.keys(MOVES).filter(id => checkMove(id, body, base));
}

export function mid(a, b) {
  if (!a || !b) return null;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
