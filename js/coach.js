import { GUARD, POSES, COACH_TEXT, clonePose, lerpPose } from './moves.js';
import { BONES } from './pose.js';

/** The neon instructor on the left: demonstrates each move just before it's due. */
export class Coach {
  constructor(canvas, labelEl) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.label = labelEl;
    this.pose = clonePose(GUARD);
    this.lastText = '';
  }

  setText(text) {
    if (text !== this.lastText) {
      this.label.textContent = text;
      this.lastText = text;
    }
  }

  /**
   * notes: sorted note list; t: song time; spb: seconds per beat; beatPhase 0..1
   */
  update(dt, notes, t, spb, beatPhase) {
    let next = null;
    for (const n of notes) {
      if (n.time >= t - 0.12) { next = n; break; }
    }
    let target = GUARD;
    let bounce = 0;
    if (next && next.time - t < spb * 0.85) {
      target = POSES[next.move];
      this.setText(COACH_TEXT[next.move]);
    } else {
      bounce = beatPhase == null ? 0 : -Math.abs(Math.sin(beatPhase * Math.PI)) * 0.12;
      if (next && next.time - t < spb * 3) this.setText('NEXT: ' + COACH_TEXT[next.move]);
      else if (!next) this.setText('GREAT WORK!');
    }
    lerpPose(this.pose, target, 1 - Math.exp(-dt * 16));
    this.draw(bounce);
  }

  idle(dt, text) {
    lerpPose(this.pose, GUARD, 1 - Math.exp(-dt * 10));
    this.setText(text);
    this.draw(0);
  }

  draw(bounce) {
    const { g, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const k = 36;
    const ox = W / 2, oy = 108;
    const P = n => [ox + this.pose[n][0] * k, oy - (this.pose[n][1] + bounce) * k];
    g.clearRect(0, 0, W, H);

    // floor glow
    const fy = oy + 3.55 * k;
    const grad = g.createRadialGradient(ox, fy, 4, ox, fy, 90);
    grad.addColorStop(0, 'rgba(255,43,214,0.55)');
    grad.addColorStop(1, 'rgba(255,43,214,0)');
    g.fillStyle = grad;
    g.fillRect(0, fy - 20, W, 40);

    // torso fill
    const ls = P('lSh'), rs = P('rSh'), lh = P('lHip'), rh = P('rHip');
    g.fillStyle = 'rgba(255,43,214,0.18)';
    g.beginPath();
    g.moveTo(...ls); g.lineTo(...rs); g.lineTo(...rh); g.lineTo(...lh); g.closePath();
    g.fill();

    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowColor = '#ff2bd6';
    g.shadowBlur = 18;
    g.strokeStyle = '#ff6ad5';
    g.lineWidth = 10;
    for (const [a, b] of BONES) {
      const p = P(a), q = P(b);
      g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke();
    }
    // bright core
    g.shadowBlur = 0;
    g.strokeStyle = '#ffd6f5';
    g.lineWidth = 3;
    for (const [a, b] of BONES) {
      const p = P(a), q = P(b);
      g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke();
    }
    // neck + head
    const neck = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2];
    const nose = P('nose');
    g.shadowBlur = 18;
    g.strokeStyle = '#ff6ad5';
    g.lineWidth = 8;
    g.beginPath(); g.moveTo(...neck); g.lineTo(nose[0], nose[1] + 10); g.stroke();
    g.fillStyle = 'rgba(255,43,214,0.25)';
    g.lineWidth = 5;
    g.beginPath(); g.arc(nose[0], nose[1] - 4, 17, 0, Math.PI * 2); g.fill(); g.stroke();
    // friendly face
    g.shadowBlur = 0;
    g.fillStyle = '#fff';
    for (const dx of [-6, 6]) { g.beginPath(); g.arc(nose[0] + dx, nose[1] - 7, 2.6, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = '#fff';
    g.lineWidth = 2.5;
    g.beginPath(); g.arc(nose[0], nose[1] - 3, 7, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    g.shadowBlur = 18;
    // hands
    g.fillStyle = '#fff';
    g.shadowColor = '#00f0ff';
    g.shadowBlur = 16;
    for (const n of ['lWr', 'rWr']) {
      const p = P(n);
      g.beginPath(); g.arc(p[0], p[1], 8, 0, Math.PI * 2); g.fill();
    }
    g.shadowBlur = 0;
  }
}
