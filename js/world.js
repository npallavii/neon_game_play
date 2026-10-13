import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MOVES } from './moves.js';
import { BONES } from './pose.js';
import { Decor } from './decor.js';

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
    // Render resolution adapts to keep a steady frame rate (see adaptQuality).
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    this.pixelRatio = this.maxPixelRatio;
    r.setPixelRatio(this.pixelRatio);
    this.perf = { avg: 1 / 60, timer: 0, goodFor: 0 };
    this.tier = 0;
    this.mountains = [];
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
    this.composer.setPixelRatio(this.pixelRatio);

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
    this.decor = new Decor(this.scene);
    this.beatCount = 0;
    this.lastPhase = 0;

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
        uBeat: { value: 0 },
        uFlashA: { value: new THREE.Vector3() },
        uFlashB: { value: new THREE.Vector3() },
        uLaneX: { value: new THREE.Vector2() },
        uLaneW: { value: 3 },
        uFog: { value: FOG },
      },
      vertexShader: `varying vec3 vPos; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vPos = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        varying vec3 vPos; uniform float uOffset; uniform float uPulse; uniform float uBeat; uniform vec3 uFog;
        uniform vec3 uFlashA; uniform vec3 uFlashB; uniform vec2 uLaneX; uniform float uLaneW;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec3 hue(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
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
          // light-up rainbow dance floor on the track
          vec2 cell = floor(g);
          vec2 inTile = fract(g);
          float tile = step(0.07, inTile.x) * step(inTile.x, 0.93) * step(0.07, inTile.y) * step(inTile.y, 0.93);
          float onTrack = step(abs(vPos.x), 3.0);
          float lit = step(0.55, hash(cell + vec2(floor(uBeat), 0.0)));
          vec3 tc = hue(fract(cell.x * 0.13 + cell.y * 0.07 + uBeat * 0.05));
          float fadeT = 1.0 - smoothstep(20.0, 80.0, d);
          col += tc * tile * onTrack * lit * fadeT * (0.22 + uPulse * 0.45);
          // tiles under a player flash in their colour when they score
          float nearP = 1.0 - smoothstep(1.0, 16.0, d);
          float inA = 1.0 - step(uLaneW, abs(vPos.x - uLaneX.x));
          float inB = 1.0 - step(uLaneW, abs(vPos.x - uLaneX.y));
          col += (uFlashA * inA + uFlashB * inB) * tile * nearP;
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
      const solid = new THREE.Mesh(geo, fill), lines = new THREE.Mesh(geo, wire);
      this.scene.add(solid, lines);
      this.mountains.push(solid, lines);
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
    // Centre divider, shown in 2-player mode
    this.divider = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 300), new THREE.MeshBasicMaterial({ color: neon(0xffd23f, 1.2), toneMapped: false }));
    this.divider.position.set(0, 0.03, -148);
    this.divider.visible = false;
    this.scene.add(this.divider);
  }

  // ---------------- Player avatars ----------------

  buildAvatar() {
    this.avatars = [
      new Avatar(this, { bone: 0x00e5ff, joint: 0x9ff8ff, hand: 0xff2bd6, face: '#7ff6ff', glow: '0,240,255' }),
      new Avatar(this, { bone: 0xff6ad5, joint: 0xffc2ee, hand: 0xffd23f, face: '#ffb3e6', glow: '255,106,213' }),
    ];
    this.setPlayers(1);
  }

  /** 1 player: one centred lane. 2 players: two lanes side by side. */
  setPlayers(n) {
    this.numPlayers = n;
    this.laneX = n === 2 ? [-1.55, 1.55] : [0, 0];
    this.laneWidth = n === 2 ? 2.9 : 5.6;
    this.camZ = n === 2 ? 4.9 : 3.9;
    this.divider.visible = n === 2;
    const u = this.grid.material.uniforms;
    u.uLaneX.value.set(this.laneX[0], this.laneX[1]);
    u.uLaneW.value = n === 2 ? 1.5 : 3.0;
    if (n === 1) this.avatars[1].set(null);
  }

  faceSprite(excited, ring = '#7ff6ff') {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.shadowColor = ring;
    g.shadowBlur = 10;
    g.lineWidth = 8;
    g.strokeStyle = ring;
    g.fillStyle = 'rgba(255, 255, 255, 0.12)';
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    g.lineCap = 'round';
    if (excited) {
      // star eyes + big open smile
      for (const x of [44, 84]) star(g, x, 54, 11);
      g.fillStyle = '#ff6ad5';
      g.beginPath(); g.arc(64, 74, 22, 0, Math.PI); g.closePath(); g.fill();
    } else {
      for (const x of [46, 82]) { g.beginPath(); g.arc(x, 54, 7, 0, Math.PI * 2); g.fill(); }
      g.lineWidth = 7;
      g.beginPath(); g.arc(64, 70, 22, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
      g.fillStyle = 'rgba(255, 106, 213, 0.6)';
      for (const x of [30, 98]) { g.beginPath(); g.arc(x, 74, 8, 0, Math.PI * 2); g.fill(); }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Show the excited face for a moment (after a hit). */
  cheer(i = 0) {
    this.avatars[i].moodUntil = this.time + 0.5;
  }

  /** Short burst of extra warp + glow when the speed level goes up. */
  boost() {
    this.boostT = 1;
  }

  confetti() {
    this.decor.confetti();
  }

  /** body: pose dict in body space (or null to hide); i: player index */
  setAvatar(body, i = 0) {
    this.avatars[i].set(body, this.laneX[i]);
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

  sharedGeo(key, make) {
    const c = (this.geoCache ??= new Map());
    if (!c.has(key)) c.set(key, make());
    return c.get(key);
  }

  makeNoteMesh(note) {
    const m = MOVES[note.move];
    const group = new THREE.Group();
    const edgeMat = new THREE.LineBasicMaterial({ color: neon(m.color, 2.4), toneMapped: false, transparent: true });
    const fillMat = new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.22, depthWrite: false });
    const addBox = (w, h, d) => {
      const geo = this.sharedGeo(`box${w}/${h}/${d}`, () => new THREE.BoxGeometry(w, h, d));
      group.add(new THREE.Mesh(geo, fillMat));
      group.add(new THREE.LineSegments(this.sharedGeo(`edge${w}/${h}/${d}`, () => new THREE.EdgesGeometry(geo)), edgeMat));
    };
    const addFace = (tex, w, h, z) => {
      const p = new THREE.Mesh(this.sharedGeo(`plane${w}/${h}`, () => new THREE.PlaneGeometry(w, h)), new THREE.MeshBasicMaterial({
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
        const ring = new THREE.Mesh(this.sharedGeo('aimRing', () => new THREE.RingGeometry(0.3, 0.34, 48)), new THREE.MeshBasicMaterial({
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
        const W = this.laneWidth;
        addBox(W, 0.32, 0.35);
        addFace(this.bannerTexture('▼  DUCK  ▼', m.color, Math.round((64 * W) / 0.32), 64), W, 0.32, 0.18);
        target = bw(0, 0.75);
        group.position.copy(target).setZ(0);
        break;
      }
      case 'jump': {
        addBox(this.laneWidth, 0.22, 0.35);
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
    // shift into this player's lane
    const lx = this.laneX[note.player || 0] || 0;
    if (lx) {
      group.position.x += lx;
      target.x += lx;
      if (note.ring) note.ring.position.x += lx;
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
        const w = Math.max(0, 1 - (this.time - note.missedAt) / 0.4);
        g.rotation.z = Math.sin(this.time * 60) * 0.25 * w; // "crack" wobble
      }
      if (g.position.z > this.camera.position.z + 0.5) this.removeNote(note);
    }
  }

  removeNote(note) {
    this.scene.remove(note.mesh);
    // geometries and textures are shared/cached; only the per-block materials are freed
    note.mesh.traverse(o => { if (o.material) o.material.dispose(); });
    if (note.ring) { this.scene.remove(note.ring); note.ring.material.dispose(); }
    this.notes.delete(note);
  }

  clearNotes() {
    for (const n of [...this.notes]) this.removeNote(n);
  }

  /** parts: which body parts did it ('lWr', 'rWr', 'lKn', 'rKn' or 'body') */
  hitNote(note, grade, parts = ['body']) {
    const color = MOVES[note.move].color;
    const pos = note.target.clone();
    pos.z = Math.max(note.mesh.position.z, -1);
    const big = grade === 'perfect';
    this.shatter(pos, color, big ? 16 : 11);         // block breaks into glowing pieces
    this.burst(pos, color, big ? 70 : 45);           // sparks
    this.shockwave(pos, color);                      // thin ring
    this.flare(pos, color, big ? 1.4 : 1);          // big soft colour burst
    this.flashFloor(note.player || 0, color);        // dance-floor tiles light up
    this.avatars[note.player || 0].flash(parts, color);
    if (big) this.impact();                          // punchy camera bump
    this.removeNote(note);
  }

  missNote(note) {
    note.missed = true;
    note.missedAt = this.time;
    this.shake = 0.12;
    this.cross(note.target);
  }

  // ---------------- Particles ----------------

  buildParticles() {
    this.bursts = [];
    this.waves = [];
    this.fx = [];        // simple timed effects: { obj, age, life, step(k) }
    this.floorFlash = [{ c: new THREE.Color(), k: 0 }, { c: new THREE.Color(), k: 0 }];
    this.impactT = 0;
    this.buildShards();
  }

  // Block shards: one instanced mesh, so 300 pieces cost a single draw call.
  buildShards() {
    const N = 320;
    const mesh = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.1), new THREE.MeshBasicMaterial({ toneMapped: false }), N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) mesh.setMatrixAt(i, zero);
    this.scene.add(mesh);
    this.shardMesh = mesh;
    this.shards = [];
    this.shardFree = Array.from({ length: N }, (_, i) => i);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._zero = zero;
  }

  shatter(pos, color, n) {
    const c = neon(color, 1.9);
    for (let i = 0; i < n; i++) {
      const idx = this.shardFree.pop();
      if (idx === undefined) break;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.1, Math.random() * 0.6 + 0.2).normalize();
      this.shards.push({
        idx,
        p: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, 0)),
        v: dir.multiplyScalar(3 + Math.random() * 4),
        r: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        rv: new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18),
        size: 0.8 + Math.random() * 0.9,
        age: 0,
        life: 0.6 + Math.random() * 0.25,
      });
      this.shardMesh.setColorAt(idx, c);
    }
    this.shardMesh.instanceColor.needsUpdate = true;
  }

  updateShards(dt) {
    if (!this.shards.length) return;
    const { _m, _q, _e, _s } = this;
    this.shards = this.shards.filter(sh => {
      sh.age += dt;
      if (sh.age >= sh.life) {
        this.shardMesh.setMatrixAt(sh.idx, this._zero);
        this.shardFree.push(sh.idx);
        return false;
      }
      sh.v.y -= 9 * dt;
      sh.p.addScaledVector(sh.v, dt);
      sh.r.addScaledVector(sh.rv, dt);
      const k = sh.size * (1 - sh.age / sh.life);
      _q.setFromEuler(_e.set(sh.r.x, sh.r.y, sh.r.z));
      _m.compose(sh.p, _q, _s.set(k, k, k));
      this.shardMesh.setMatrixAt(sh.idx, _m);
      return true;
    });
    this.shardMesh.instanceMatrix.needsUpdate = true;
  }

  glowTexture() {
    return this.labelTexture('glow', c => {
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    });
  }

  /** Big soft burst of light in the block's colour. */
  flare(pos, color, size = 1) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture(), color: neon(color, 1.6), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    sp.position.copy(pos);
    this.scene.add(sp);
    this.fx.push({
      obj: sp, age: 0, life: 0.4,
      step: k => { sp.scale.setScalar((0.6 + k * 2.6) * size); sp.material.opacity = (1 - k) * (1 - k); },
    });
  }

  /** Red ✕ where a block was missed. */
  cross(pos) {
    const tex = this.labelTexture('cross', c => {
      c.width = c.height = 128;
      const g = c.getContext('2d');
      g.strokeStyle = '#ff3355';
      g.shadowColor = '#ff3355';
      g.shadowBlur = 16;
      g.lineWidth = 16;
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(32, 32); g.lineTo(96, 96); g.moveTo(96, 32); g.lineTo(32, 96); g.stroke();
    });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    sp.position.copy(pos);
    sp.position.z = 0.3;
    this.scene.add(sp);
    this.fx.push({
      obj: sp, age: 0, life: 0.6,
      step: k => { sp.scale.setScalar(0.45 + Math.min(1, k * 4) * 0.2); sp.material.opacity = 1 - k * k; },
    });
  }

  flashFloor(player, color) {
    const f = this.floorFlash[player];
    f.c.setHex(color);
    f.k = 1;
  }

  /** Short punchy camera bump (for PERFECT hits). */
  impact() {
    this.impactT = 1;
  }

  updateFx(dt) {
    this.fx = this.fx.filter(f => {
      f.age += dt;
      const k = Math.min(1, f.age / f.life);
      f.step(k);
      if (k >= 1) {
        this.scene.remove(f.obj);
        f.obj.material.dispose();
        return false;
      }
      return true;
    });
    const u = this.grid.material.uniforms;
    this.floorFlash.forEach((f, i) => {
      f.k = Math.max(0, f.k - dt * 3);
      const target = i === 0 ? u.uFlashA.value : u.uFlashB.value;
      target.set(f.c.r, f.c.g, f.c.b).multiplyScalar(f.k * 0.9);
    });
    this.impactT = Math.max(0, this.impactT - dt * 6);
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
    const ring = new THREE.Mesh(this.sharedGeo('wave', () => new THREE.RingGeometry(0.22, 0.25, 48)), new THREE.MeshBasicMaterial({
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
        this.scene.remove(w.ring); w.ring.material.dispose();
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
    if (beatPhase != null && beatPhase < this.lastPhase) this.beatCount++;
    this.lastPhase = beatPhase ?? 0;
    this.grid.material.uniforms.uBeat.value = this.beatCount;

    this.grid.material.uniforms.uOffset.value = this.gridOffset;
    this.grid.material.uniforms.uPulse.value = this.pulse;
    this.sun.material.uniforms.uTime.value = this.time;
    this.sun.material.uniforms.uPulse.value = this.pulse;
    this.halo.material.opacity = 0.35 + this.pulse * 0.15;
    this.hitLineMat.opacity = 0.45 + this.pulse * 0.55;
    this.stars.rotation.y = this.time * 0.004;
    this.boostT = Math.max(0, (this.boostT || 0) - dt * 1.5);
    this.bloom.strength = 0.75 + this.pulse * 0.2 + this.boostT * 0.6;
    // camera "warp": field of view widens as you go faster
    const fast = Math.min(1, Math.max(0, (scrollSpeed - 13) / 17));
    const fov = this.baseFov + fast * 9 + this.boostT * 6 - this.impactT * 2.5;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    this.updateParticles(dt);
    this.updateShards(dt);
    this.updateFx(dt);
    this.adaptQuality(dt);
    this.decor.update(dt, scrollSpeed, this.pulse, this.beatCount);

    // camera sway + shake
    this.shake = Math.max(0, this.shake - dt);
    const s = this.shake * 0.25 + this.impactT * 0.05;
    this.camera.position.set(
      Math.sin(this.time * 0.35) * 0.08 + (Math.random() - 0.5) * s,
      1.7 + Math.sin(this.time * 0.5) * 0.03 + (Math.random() - 0.5) * s,
      this.camZ,
    );
    this.camera.lookAt(this.lookAt);

    this.composer.render(dt);
  }

  toScreen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight };
  }

  /** 0 = everything on, 1 = no palm trees / gems / mountains, 2 = also no glow (bloom). */
  setTier(t) {
    this.tier = t;
    this.decor.setLite(t >= 1);
    for (const m of this.mountains) m.visible = t < 1;
    this.bloom.enabled = t < 2;
  }

  get qualityName() {
    if (this.tier >= 2) return 'Smooth (max)';
    if (this.tier === 1) return 'Smooth';
    return this.pixelRatio >= 1 ? 'High' : 'Medium';
  }

  /** Lower the render resolution when frames get slow, raise it again when there's headroom. */
  adaptQuality(dt) {
    const f = this.perf;
    if (dt <= 0) return;
    f.avg += (dt - f.avg) * 0.05;
    f.timer += dt;
    if (f.timer < 1.5) return;
    f.timer = 0;
    let next = this.pixelRatio;
    if (f.avg > 1 / 50) {
      f.goodFor = 0;
      // Smooth mode: first lower the resolution, then switch off heavy extras
      if (this.pixelRatio > 0.6) next = Math.max(0.6, this.pixelRatio - 0.2);
      else if (this.tier < 2) this.setTier(this.tier + 1);
    } else if (f.avg < 1 / 57) {
      f.goodFor += 1.5;
      if (f.goodFor >= 8 && this.tier > 0) { this.setTier(this.tier - 1); f.goodFor = 0; }
      else if (f.goodFor >= 6 && this.tier === 0 && this.pixelRatio < this.maxPixelRatio) { next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.1); f.goodFor = 0; }
    } else f.goodFor = 0;
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.composer.setPixelRatio(next);
      this.resize();
    }
  }

  /** Build every block type once up front so nothing stalls mid-song (shader compile / texture upload). */
  prewarm() {
    const temp = Object.keys(MOVES).map((move, i) => ({ move, id: -1 - i, time: -100 }));
    for (const n of temp) this.spawnNote(n);
    this.burst(new THREE.Vector3(0, -50, -5), 0xffffff, 4);
    this.shockwave(new THREE.Vector3(0, -50, -5), 0xffffff);
    this.flare(new THREE.Vector3(0, -50, -5), 0xffffff);
    this.cross(new THREE.Vector3(0, -50, -5));
    this.shatter(new THREE.Vector3(0, -50, -5), 0xffffff, 1);
    this.decor.confetti(new THREE.Vector3(0, -50, -5), 4);
    this.renderer.compile(this.scene, this.camera);
    for (const tex of this.texCache.values()) this.renderer.initTexture(tex);
    for (const n of temp) this.removeNote(n);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // keep the play area visible on narrow screens
    this.baseFov = w / h < 1.2 ? 60 * Math.min(1.7, 1.2 / (w / h)) : 60;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }
}

/** One neon stick-figure player (bones, joints, smiley head, floor glow). */
class Avatar {
  constructor(world, c) {
    this.world = world;
    const scene = world.scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    const boneMat = new THREE.MeshBasicMaterial({ color: neon(c.bone, 0.9), toneMapped: false, transparent: true, opacity: 0.85 });
    const jointMat = new THREE.MeshBasicMaterial({ color: neon(c.joint, 0.9), toneMapped: false });
    this.handColor = neon(c.hand, 1.6);
    this.boneMat = boneMat;
    this.boneColor = boneMat.color.clone();
    const cyl = world.sharedGeo('avatarBone', () => {
      const g = new THREE.CylinderGeometry(0.028, 0.028, 1, 8, 1, true);
      g.translate(0, 0.5, 0);
      g.rotateX(Math.PI / 2); // along +z, so lookAt() aims it
      return g;
    });
    this.bones = BONES.concat([['neck', 'nose']]).map(([a, b]) => {
      const m = new THREE.Mesh(cyl, boneMat);
      this.group.add(m);
      return { a, b, m };
    });
    const sph = world.sharedGeo('avatarJoint', () => new THREE.SphereGeometry(0.05, 12, 8));
    const hand = world.sharedGeo('avatarHand', () => new THREE.SphereGeometry(0.1, 16, 12));
    this.joints = {};
    for (const n of ['lSh', 'rSh', 'lEl', 'rEl', 'lHip', 'rHip', 'lKn', 'rKn', 'lAn', 'rAn']) {
      const m = new THREE.Mesh(sph, jointMat);
      this.group.add(m);
      this.joints[n] = m;
    }
    for (const n of ['lWr', 'rWr']) {
      const m = new THREE.Mesh(hand, new THREE.MeshBasicMaterial({ color: this.handColor.clone(), toneMapped: false }));
      this.group.add(m);
      this.joints[n] = m;
    }
    // light trails behind the hands (brighter when moving fast / after a hit)
    this.TRAIL = 14;
    this.trails = {};
    for (const n of ['lWr', 'rWr']) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.TRAIL * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.TRAIL * 3), 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 0.16, vertexColors: true, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      pts.frustumCulled = false;
      scene.add(pts);
      this.trails[n] = { pts, hist: [], color: new THREE.Color(c.hand) };
    }
    this.flashUntil = {};
    this.flashColor = new THREE.Color();
    this._white = new THREE.Color(2.5, 2.5, 2.5);
    this.faces = { happy: world.faceSprite(false, c.face), yay: world.faceSprite(true, c.face) };
    this.head = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.faces.happy, transparent: true, depthWrite: false, toneMapped: false }));
    this.head.scale.set(0.42, 0.42, 1);
    this.group.add(this.head);

    const gc = document.createElement('canvas');
    gc.width = gc.height = 128;
    const g = gc.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, `rgba(${c.glow},0.35)`);
    grad.addColorStop(1, `rgba(${c.glow},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.4), new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(gc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.set(0, 0.03, 0);
    scene.add(this.glow);

    this.moodUntil = 0;
    this.V = {};
    this.P = {};
    this.group.visible = false;
    this.glow.visible = false;
  }

  /** body: pose dict in body space or null; laneX: sideways offset in metres */
  set(body, laneX = 0) {
    const visible = !!body;
    this.group.visible = visible;
    this.glow.visible = visible;
    for (const n in this.trails) this.trails[n].pts.visible = visible;
    if (!visible) { for (const n in this.trails) this.trails[n].hist.length = 0; return; }
    // reuse vectors every frame (no garbage -> no GC stutter)
    const { V, P } = this;
    for (const k in P) P[k] = null;
    for (const k in body) P[k] = (V[k] ??= new THREE.Vector3()).set(laneX + body[k][0] * S, OY + body[k][1] * S, 0.25);
    if (P.lSh && P.rSh) P.neck = (V.neck ??= new THREE.Vector3()).copy(P.lSh).add(P.rSh).multiplyScalar(0.5);
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
      this.head.position.y += 0.04;
      const face = this.world.time < this.moodUntil ? this.faces.yay : this.faces.happy;
      if (this.head.material.map !== face) { this.head.material.map = face; this.head.material.needsUpdate = true; }
    } else this.head.visible = false;
    if (P.neck) this.glow.position.x = P.neck.x;
    this.updateFlash(P);
  }

  /** Light up the part that scored. parts: joint names, or ['body'] for the whole figure. */
  flash(parts, color) {
    const until = this.world.time + 0.35;
    for (const p of parts) this.flashUntil[p] = until;
    this.flashColor.setHex(color);
  }

  flashLevel(name) {
    const u = this.flashUntil[name];
    return u ? Math.max(0, (u - this.world.time) / 0.35) : 0;
  }

  updateFlash(P) {
    const body = this.flashLevel('body');
    this.boneMat.color.copy(this.boneColor).lerp(this._white, body * 0.8);
    for (const n of ['lWr', 'rWr', 'lKn', 'rKn']) {
      const j = this.joints[n];
      const k = Math.max(this.flashLevel(n), body);
      j.scale.setScalar(1 + k * (n.endsWith('Wr') ? 1.6 : 2.4));
      if (n.endsWith('Wr')) j.material.color.copy(this.handColor).lerp(this._white, k);
    }
    // trails
    for (const n in this.trails) {
      const tr = this.trails[n];
      const p = P[n];
      if (!p) { tr.hist.length = 0; continue; }
      // recycle the oldest point vector (no per-frame allocations)
      const v = tr.hist.length >= this.TRAIL ? tr.hist.pop() : new THREE.Vector3();
      tr.hist.unshift(v.copy(p));
      const pos = tr.pts.geometry.attributes.position.array;
      const col = tr.pts.geometry.attributes.color.array;
      const boost = 1 + this.flashLevel(n) * 2;
      for (let i = 0; i < this.TRAIL; i++) {
        const h = tr.hist[Math.min(i, tr.hist.length - 1)];
        pos[i * 3] = h.x; pos[i * 3 + 1] = h.y; pos[i * 3 + 2] = h.z - 0.02;
        // brightness = how fast the hand was moving there, fading along the trail
        const prev = tr.hist[Math.min(i + 1, tr.hist.length - 1)];
        const speed = Math.min(1, h.distanceTo(prev) * 12);
        const k = speed * (1 - i / this.TRAIL) * boost;
        const c = this.flashLevel(n) > 0 ? this.flashColor : tr.color;
        col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
      }
      tr.pts.geometry.attributes.position.needsUpdate = true;
      tr.pts.geometry.attributes.color.needsUpdate = true;
    }
  }
}

function star(g, x, y, r) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
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
