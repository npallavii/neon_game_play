import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MOVES } from './moves.js';
import { BONES } from './pose.js';

// Body space -> world: 1 body unit (shoulder width) = S metres, shoulders at height OY.
export const S = 0.5;
export const OY = 1.75;
export const SPEED = 20; // block speed, metres / second
const FOG = new THREE.Color(0x1a0433);

const bw = (x, y, z = 0) => new THREE.Vector3(x * S, OY + y * S, z);
const neon = (hex, k = 1.8) => new THREE.Color(hex).multiplyScalar(k);

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(FOG, 30, 150);
    this.scene.background = this.skyTexture();

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    this.camera.position.set(0, 1.7, 3.9);
    this.lookAt = new THREE.Vector3(0, 1.4, -12);
    this.camera.lookAt(this.lookAt);

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.8, 0.45, 0.4);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.speed = SPEED;
    this.time = 0;
    this.gridOffset = 0;
    this.pulse = 0;
    this.shake = 0;
    this.texCache = new Map();
    this.notes = new Set();

    this.buildSun();
    this.buildGrid();
    this.buildMountains();
    this.buildStars();
    this.buildRails();
    this.buildAvatar();
    this.buildParticles();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------------- Environment ----------------

  skyTexture() {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#02000a');
    grad.addColorStop(0.35, '#0d0226');
    grad.addColorStop(0.5, '#2a0650');
    grad.addColorStop(0.56, '#5a0f6e');
    grad.addColorStop(0.6, '#1a0433');
    grad.addColorStop(1, '#07010f');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 512);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  buildSun() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPulse: { value: 0 } },
      transparent: true,
      fog: false,
      depthWrite: false,
      toneMapped: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uTime; uniform float uPulse;
        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          if (r > 1.0) discard;
          float y = vUv.y;
          vec3 top = vec3(1.0, 0.9, 0.35);
          vec3 bot = vec3(1.0, 0.12, 0.6);
          vec3 col = mix(bot, top, smoothstep(0.1, 0.95, y));
          if (y < 0.55) {
            float band = fract(y * 14.0 + uTime * 0.35);
            float th = (0.55 - y) / 0.55 * 0.75;
            if (band < th) discard;
          }
          float edge = smoothstep(1.0, 0.97, r);
          gl_FragColor = vec4(col * (0.55 + uPulse * 0.2), edge);
        }`,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), mat);
    this.sun.position.set(0, 22, -260);
    this.scene.add(this.sun);

    // Soft halo
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,80,180,0.3)');
    grad.addColorStop(0.5, 'rgba(160,40,200,0.1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(220, 220, 1);
    halo.position.set(0, 22, -262);
    this.scene.add(halo);
    this.halo = halo;
  }

  buildGrid() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uOffset: { value: 0 },
        uPulse: { value: 0 },
        uFog: { value: FOG },
      },
      vertexShader: `varying vec3 vPos; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vPos = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        varying vec3 vPos; uniform float uOffset; uniform float uPulse; uniform vec3 uFog;
        void main(){
          vec2 g = vec2(vPos.x, vPos.z - uOffset) / 2.0;
          vec2 fw = fwidth(g) * 1.2;
          vec2 l = abs(fract(g - 0.5) - 0.5) / fw;
          float line = 1.0 - min(min(l.x, l.y), 1.0);
          float d = max(0.0, -vPos.z);
          float near = clamp(d / 90.0, 0.0, 1.0);
          vec3 lc = mix(vec3(1.0, 0.15, 0.85), vec3(0.45, 0.2, 1.0), near);
          float lane = smoothstep(4.0, 0.0, abs(vPos.x)) * 0.12;
          vec3 base = vec3(0.025, 0.0, 0.06) + vec3(0.25, 0.0, 0.35) * lane;
          float nearFade = smoothstep(0.0, 12.0, d) * 0.6 + 0.4;
          vec3 col = base + lc * line * nearFade * (0.75 + uPulse * 0.5);
          float fog = smoothstep(30.0, 170.0, d);
          gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
        }`,
    });
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat);
    grid.rotation.x = -Math.PI / 2;
    grid.position.z = -150;
    this.scene.add(grid);
    this.grid = grid;
  }

  buildMountains() {
    const h = (x, z) => {
      const ax = Math.abs(x);
      const f = Math.max(0, (ax - 16) / 60);
      const n =
        Math.sin(x * 0.11 + z * 0.07) * 0.5 + 0.5 +
        (Math.sin(x * 0.31 - z * 0.21) * 0.5 + 0.5) * 0.6 +
        (Math.sin(x * 0.73 + z * 0.47) * 0.5 + 0.5) * 0.25;
      return Math.min(1, f) * n * 26 * (1 + Math.max(0, -z - 120) / 120);
    };
    const fill = new THREE.MeshBasicMaterial({ color: 0x0a0018, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const wire = new THREE.MeshBasicMaterial({ color: neon(0xb026ff, 1.1), wireframe: true, transparent: true, opacity: 0.55 });
    for (const side of [-1, 1]) {
      const geo = new THREE.PlaneGeometry(130, 300, 40, 70);
      geo.rotateX(-Math.PI / 2);
      geo.translate(side * (16 + 65), 0, -140);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals();
      this.scene.add(new THREE.Mesh(geo, fill));
      this.scene.add(new THREE.Mesh(geo, wire));
    }
  }

  buildStars() {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI - Math.PI;
      const ph = Math.random() * 0.45 + 0.04;
      const r = 300;
      pos[i * 3] = Math.cos(th) * Math.cos(ph) * r;
      pos[i * 3 + 1] = Math.sin(ph) * r;
      pos[i * 3 + 2] = Math.sin(th) * Math.cos(ph) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85,
    }));
    this.scene.add(this.stars);
  }

  buildRails() {
    const mat = new THREE.MeshBasicMaterial({ color: neon(0x00f0ff, 1.1), toneMapped: false });
    for (const x of [-3.2, 3.2]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 300), mat);
      rail.position.set(x, 0.03, -148);
      this.scene.add(rail);
    }
    // Hit line across the floor at the player
    this.hitLineMat = new THREE.MeshBasicMaterial({ color: neon(0xff2bd6, 2), toneMapped: false, transparent: true, opacity: 0.7 });
    const hit = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.03, 0.08), this.hitLineMat);
    hit.position.set(0, 0.02, 0);
    this.scene.add(hit);
    // Floor glow under the player
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,240,255,0.35)');
    grad.addColorStop(1, 'rgba(0,240,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.4), new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.floorGlow.rotation.x = -Math.PI / 2;
    this.floorGlow.position.set(0, 0.03, 0);
    this.scene.add(this.floorGlow);
  }

  // ---------------- Player avatar ----------------

  buildAvatar() {
    this.avatar = new THREE.Group();
    this.scene.add(this.avatar);
    const boneMat = new THREE.MeshBasicMaterial({ color: neon(0x00e5ff, 0.9), toneMapped: false, transparent: true, opacity: 0.85 });
    const jointMat = new THREE.MeshBasicMaterial({ color: neon(0x9ff8ff, 0.9), toneMapped: false });
    this.handMat = new THREE.MeshBasicMaterial({ color: neon(0xff2bd6, 1.6), toneMapped: false });
    const cyl = new THREE.CylinderGeometry(0.028, 0.028, 1, 8, 1, true);
    cyl.translate(0, 0.5, 0);
    cyl.rotateX(Math.PI / 2); // along +z, so lookAt() aims it
    this.bones = BONES.concat([['neck', 'nose']]).map(([a, b]) => {
      const m = new THREE.Mesh(cyl, boneMat);
      this.avatar.add(m);
      return { a, b, m };
    });
    const sph = new THREE.SphereGeometry(0.05, 12, 8);
    this.joints = {};
    for (const n of ['lSh', 'rSh', 'lEl', 'rEl', 'lHip', 'rHip', 'lKn', 'rKn', 'lAn', 'rAn']) {
      const m = new THREE.Mesh(sph, jointMat);
      this.avatar.add(m);
      this.joints[n] = m;
    }
    const hand = new THREE.SphereGeometry(0.1, 16, 12);
    for (const n of ['lWr', 'rWr']) {
      const m = new THREE.Mesh(hand, this.handMat);
      this.avatar.add(m);
      this.joints[n] = m;
    }
    this.head = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 8, 32), boneMat);
    this.avatar.add(this.head);
    this.avatar.visible = false;
    this._v = new THREE.Vector3();
  }

  /** body: pose dict in body space or null */
  setAvatar(body) {
    if (!body) { this.avatar.visible = false; return; }
    this.avatar.visible = true;
    const P = {};
    for (const k in body) P[k] = bw(body[k][0], body[k][1], 0.25);
    if (P.lSh && P.rSh) P.neck = P.lSh.clone().add(P.rSh).multiplyScalar(0.5);
    for (const { a, b, m } of this.bones) {
      const p = P[a], q = P[b];
      if (!p || !q) { m.visible = false; continue; }
      m.visible = true;
      m.position.copy(p);
      m.lookAt(q);
      m.scale.set(1, 1, p.distanceTo(q));
    }
    for (const n in this.joints) {
      const j = this.joints[n];
      if (P[n]) { j.visible = true; j.position.copy(P[n]); } else j.visible = false;
    }
    if (P.nose) {
      this.head.visible = true;
      this.head.position.copy(P.nose);
    } else this.head.visible = false;
    const c = P.neck;
    if (c) this.floorGlow.position.x = c.x;
  }

  // ---------------- Notes ----------------

  labelTexture(key, draw) {
    if (this.texCache.has(key)) return this.texCache.get(key);
    const c = document.createElement('canvas');
    draw(c);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.texCache.set(key, t);
    return t;
  }

  faceTexture(moveId) {
    const m = MOVES[moveId];
    const css = '#' + new THREE.Color(m.color).getHexString();
    return this.labelTexture('face-' + moveId, c => {
      c.width = c.height = 256;
      const g = c.getContext('2d');
      g.shadowColor = css;
      g.shadowBlur = 22;
      g.strokeStyle = css;
      g.lineWidth = 12;
      roundRect(g, 22, 22, 212, 212, 36);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fill();
      // arrow
      g.save();
      g.translate(128, 112);
      g.rotate(-m.arrow);
      g.fillStyle = '#ffffff';
      g.shadowColor = css;
      g.shadowBlur = 18;
      g.beginPath();
      g.moveTo(62, 0); g.lineTo(6, -46); g.lineTo(6, -20); g.lineTo(-56, -20);
      g.lineTo(-56, 20); g.lineTo(6, 20); g.lineTo(6, 46); g.closePath();
      g.fill();
      g.restore();
      g.font = '900 34px Orbitron, Arial Black, sans-serif';
      g.textAlign = 'center';
      g.fillStyle = '#fff';
      g.fillText(m.label, 128, 210);
    });
  }

  bannerTexture(text, color, w = 512, h = 128, stripes = false) {
    const css = '#' + new THREE.Color(color).getHexString();
    return this.labelTexture(`ban-${text}-${css}-${w}x${h}-${stripes}`, c => {
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      if (stripes) {
        g.fillStyle = css + '33';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = css + '66';
        g.lineWidth = 18;
        for (let x = -h; x < w + h; x += 56) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + h, 0); g.stroke(); }
      } else {
        g.fillStyle = css + '30';
        g.fillRect(0, 0, w, h);
      }
      g.shadowColor = css;
      g.shadowBlur = 20;
      g.strokeStyle = css;
      g.lineWidth = 10;
      g.strokeRect(6, 6, w - 12, h - 12);
      g.font = `900 ${Math.round(Math.min(h * 0.5, w * 0.16))}px Orbitron, Arial Black, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#fff';
      g.fillText(text, w / 2, h / 2 + 2);
    });
  }

  makeNoteMesh(note) {
    const m = MOVES[note.move];
    const group = new THREE.Group();
    const edgeMat = new THREE.LineBasicMaterial({ color: neon(m.color, 2.4), toneMapped: false, transparent: true });
    const fillMat = new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.22, depthWrite: false });
    const addBox = (w, h, d) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      group.add(new THREE.Mesh(geo, fillMat));
      group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
    };
    const addFace = (tex, w, h, z) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, toneMapped: false, color: new THREE.Color(1.6, 1.6, 1.6),
      }));
      p.position.z = z;
      group.add(p);
      return p;
    };
    let target = null; // world position where the move is "hit" (for ring + effects)

    switch (m.kind) {
      case 'hand':
      case 'knee': {
        const size = m.kind === 'knee' ? 0.42 : 0.46;
        addBox(size, size, size);
        addFace(this.faceTexture(note.move), size * 0.95, size * 0.95, size / 2 + 0.01);
        target = bw(m.pos[0], m.pos[1]);
        group.position.set(target.x, target.y, 0);
        group.userData.spin = (Math.random() - 0.5) * 0.6;
        // aim ring that waits at the hit plane
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.34, 48), new THREE.MeshBasicMaterial({
          color: neon(m.color, 2), toneMapped: false, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
        }));
        ring.position.copy(target);
        this.scene.add(ring);
        note.ring = ring;
        break;
      }
      case 'up': {
        addBox(1.3, 0.14, 0.3);
        const f = addFace(this.bannerTexture('REACH UP ▲', m.color), 1.3, 0.32, 0.16);
        f.position.y = 0.25;
        target = bw(0, 2.0);
        group.position.copy(target).setZ(0);
        break;
      }
      case 'duck': {
        addBox(5.6, 0.32, 0.35);
        addFace(this.bannerTexture('▼  DUCK  ▼', m.color, 1024, 64), 5.6, 0.32, 0.18);
        target = bw(0, 0.75);
        group.position.copy(target).setZ(0);
        break;
      }
      case 'jump': {
        addBox(5.6, 0.22, 0.35);
        const f = addFace(this.bannerTexture('▲  JUMP  ▲', m.color, 1024, 96), 2.4, 0.22, 0.18);
        f.position.y = 0;
        target = new THREE.Vector3(0, 0.22, 0);
        group.position.copy(target);
        break;
      }
      case 'dodge': {
        const wWall = 1.9, hWall = 2.7;
        addBox(wWall, hWall, 0.12);
        addFace(this.bannerTexture(m.side < 0 ? '◀ STEP' : 'STEP ▶', m.color, 256, 384, true), wWall, hWall, 0.07);
        // the wall covers the middle and the opposite side, so the player steps toward `side`
        target = new THREE.Vector3(-m.side * 0.85, hWall / 2, 0);
        group.position.copy(target);
        break;
      }
    }
    group.userData.edgeMat = edgeMat;
    group.userData.fillMat = fillMat;
    note.target = target;
    return group;
  }

  spawnNote(note) {
    note.mesh = this.makeNoteMesh(note);
    this.scene.add(note.mesh);
    this.notes.add(note);
  }

  updateNotes(t) {
    for (const note of this.notes) {
      const dz = (note.time - t) * this.speed;
      const g = note.mesh;
      g.position.z = -dz;
      if (g.userData.spin) g.rotation.z = Math.sin(t * 3 + note.id) * 0.12;
      // fade in from the fog
      const appear = Math.min(1, Math.max(0, (60 - dz) / 20));
      g.userData.edgeMat.opacity = appear;
      if (note.ring) {
        const k = Math.max(0, 1 - (note.time - t) / 1.2);
        note.ring.material.opacity = note.judged ? 0 : k * 0.9;
        note.ring.scale.setScalar(1.6 - k * 0.6);
      }
      if (note.missed) {
        g.userData.edgeMat.color.setRGB(0.4, 0.4, 0.5);
        g.userData.fillMat.opacity = 0.08;
      }
      if (g.position.z > this.camera.position.z + 0.5) this.removeNote(note);
    }
  }

  removeNote(note) {
    this.scene.remove(note.mesh);
    note.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); // cached textures stay alive
    if (note.ring) { this.scene.remove(note.ring); note.ring.geometry.dispose(); note.ring.material.dispose(); }
    this.notes.delete(note);
  }

  clearNotes() {
    for (const n of [...this.notes]) this.removeNote(n);
  }

  hitNote(note, grade) {
    const pos = note.target.clone();
    pos.z = Math.max(note.mesh.position.z, -1);
    this.burst(pos, MOVES[note.move].color, grade === 'perfect' ? 90 : 60);
    this.shockwave(pos, MOVES[note.move].color);
    this.removeNote(note);
  }

  missNote(note) {
    note.missed = true;
    this.shake = 0.12;
  }

  // ---------------- Particles ----------------

  buildParticles() {
    this.bursts = [];
    this.waves = [];
  }

  burst(pos, color, count) {
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(count * 3);
    const v = [];
    for (let i = 0; i < count; i++) {
      p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      v.push(dir.multiplyScalar(2 + Math.random() * 5));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color: neon(color, 1.6), size: 0.07, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.scene.add(pts);
    this.bursts.push({ pts, v, life: 0.8, age: 0 });
  }

  shockwave(pos, color) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.25, 48), new THREE.MeshBasicMaterial({
      color: neon(color, 1.4), transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    ring.position.copy(pos);
    this.scene.add(ring);
    this.waves.push({ ring, age: 0 });
  }

  updateParticles(dt) {
    this.bursts = this.bursts.filter(b => {
      b.age += dt;
      const a = b.pts.geometry.attributes.position;
      for (let i = 0; i < b.v.length; i++) {
        b.v[i].y -= 6 * dt;
        b.v[i].multiplyScalar(1 - 1.5 * dt);
        a.array[i * 3] += b.v[i].x * dt;
        a.array[i * 3 + 1] += b.v[i].y * dt;
        a.array[i * 3 + 2] += b.v[i].z * dt;
      }
      a.needsUpdate = true;
      b.pts.material.opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age >= b.life) {
        this.scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose();
        return false;
      }
      return true;
    });
    this.waves = this.waves.filter(w => {
      w.age += dt;
      const k = w.age / 0.45;
      w.ring.scale.setScalar(1 + k * 2.2);
      w.ring.material.opacity = Math.max(0, 1 - k);
      if (k >= 1) {
        this.scene.remove(w.ring); w.ring.geometry.dispose(); w.ring.material.dispose();
        return false;
      }
      return true;
    });
  }

  // ---------------- Frame ----------------

  /** beatPhase: 0..1 position within the current beat (or null when no music) */
  update(dt, beatPhase, scrollSpeed = SPEED) {
    this.time += dt;
    this.gridOffset = (this.gridOffset + dt * scrollSpeed) % 2000;
    this.pulse = beatPhase == null ? 0 : Math.exp(-beatPhase * 5);

    this.grid.material.uniforms.uOffset.value = this.gridOffset;
    this.grid.material.uniforms.uPulse.value = this.pulse;
    this.sun.material.uniforms.uTime.value = this.time;
    this.sun.material.uniforms.uPulse.value = this.pulse;
    this.halo.material.opacity = 0.35 + this.pulse * 0.15;
    this.hitLineMat.opacity = 0.45 + this.pulse * 0.55;
    this.stars.rotation.y = this.time * 0.004;
    this.bloom.strength = 0.75 + this.pulse * 0.2;

    this.updateParticles(dt);

    // camera sway + shake
    this.shake = Math.max(0, this.shake - dt);
    const s = this.shake * 0.25;
    this.camera.position.set(
      Math.sin(this.time * 0.35) * 0.08 + (Math.random() - 0.5) * s,
      1.7 + Math.sin(this.time * 0.5) * 0.03 + (Math.random() - 0.5) * s,
      3.9,
    );
    this.camera.lookAt(this.lookAt);

    this.composer.render(dt);
  }

  toScreen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight };
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // keep the play area visible on narrow screens
    this.camera.fov = w / h < 1.2 ? 60 * Math.min(1.7, 1.2 / (w / h)) : 60;
    this.camera.updateProjectionMatrix();
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
