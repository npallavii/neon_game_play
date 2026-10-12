import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Fun extras around the track: rainbow arches, neon palm trees, spinning gems,
// a ringed planet, shooting stars and confetti.

const RAINBOW = [0xff3b6b, 0xff9a1f, 0xffe14d, 0x39ff88, 0x00e5ff, 0x5b7bff, 0xc04dff];
const glow = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

export class Decor {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this.buildArches();
    this.buildPalms();
    this.buildGems();
    this.buildPlanet();
    this.buildStreaks();
    this.shooting = [];
    this.nextShoot = 2;
    this.confettis = [];
  }

  // ---------- Rainbow arches you run through ----------
  buildArches() {
    this.archSpacing = 24;
    this.arches = [];
    const outer = new THREE.TorusGeometry(4.3, 0.08, 8, 72, Math.PI);
    const inner = new THREE.TorusGeometry(4.0, 0.035, 6, 72, Math.PI);
    for (let i = 0; i < 7; i++) {
      const color = RAINBOW[i % RAINBOW.length];
      const g = new THREE.Group();
      const m1 = new THREE.MeshBasicMaterial({ color: glow(color, 1.3), toneMapped: false, transparent: true });
      const m2 = new THREE.MeshBasicMaterial({ color: glow(RAINBOW[(i + 2) % RAINBOW.length], 1.1), toneMapped: false, transparent: true });
      g.add(new THREE.Mesh(outer, m1), new THREE.Mesh(inner, m2));
      g.position.set(0, 0, -20 - i * this.archSpacing);
      g.userData.mats = [m1, m2];
      this.scene.add(g);
      this.arches.push(g);
    }
  }

  // ---------- Neon palm trees along the sides ----------
  buildPalms() {
    const trunkCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.25, 1.6, 0),
      new THREE.Vector3(0.15, 3.2, 0), new THREE.Vector3(-0.3, 4.6, 0),
    ]);
    const trunkGeo = new THREE.TubeGeometry(trunkCurve, 20, 0.13, 6, false);
    const top = new THREE.Vector3(-0.3, 4.6, 0);
    const frondGeos = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const pts = [0, 0.33, 0.66, 1].map(t => top.clone()
        .add(dir.clone().multiplyScalar(t * 2.3))
        .add(new THREE.Vector3(0, Math.sin(t * Math.PI * 0.9) * 0.8 - t * 1.3, 0)));
      frondGeos.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.06, 5, false));
    }
    const leavesGeo = mergeGeometries(frondGeos); // one draw call for all fronds
    const trunkMat = new THREE.MeshBasicMaterial({ color: glow(0xff2bd6, 0.9), toneMapped: false });
    const leafMats = [glow(0x39ff88, 1.1), glow(0x00e5ff, 1.1)].map(c => new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));

    this.palmSpacing = 16;
    this.palms = [];
    for (let i = 0; i < 12; i++) {
      for (const side of [-1, 1]) {
        const p = new THREE.Group();
        p.add(new THREE.Mesh(trunkGeo, trunkMat));
        const leaf = leafMats[(i + (side > 0 ? 1 : 0)) % 2];
        p.add(new THREE.Mesh(leavesGeo, leaf));
        p.position.set(side * (7.5 + (i % 3) * 1.4), 0, -8 - i * this.palmSpacing - (side > 0 ? 8 : 0));
        p.rotation.y = side > 0 ? Math.PI : 0;
        p.scale.setScalar(0.9 + ((i * 7) % 5) * 0.08);
        this.scene.add(p);
        this.palms.push(p);
      }
    }
  }

  // ---------- Floating spinning gems ----------
  buildGems() {
    const shapes = [new THREE.OctahedronGeometry(0.35), new THREE.IcosahedronGeometry(0.32), new THREE.TetrahedronGeometry(0.4)];
    this.gems = [];
    this.gemSpacing = 13;
    for (let i = 0; i < 14; i++) {
      const color = RAINBOW[(i * 3) % RAINBOW.length];
      const geo = shapes[i % shapes.length];
      const g = new THREE.Group();
      g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false })));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: glow(color, 1.8), toneMapped: false })));
      const side = i % 2 ? 1 : -1;
      g.position.set(side * (4.6 + (i % 3) * 0.6), 2.6 + (i % 4) * 0.5, -12 - i * this.gemSpacing);
      g.userData.baseY = g.position.y;
      g.userData.spin = 0.6 + (i % 5) * 0.25;
      this.scene.add(g);
      this.gems.push(g);
    }
  }

  // ---------- Speed lines that rush past when you go fast ----------
  buildStreaks() {
    const n = 90;
    this.streaks = [];
    for (let i = 0; i < n; i++) this.streaks.push(this.newStreak({}, true));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    this.streakLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: glow(0xbff8ff, 1.6), transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.streakLines.frustumCulled = false;
    this.scene.add(this.streakLines);
  }

  newStreak(s, anywhere = false) {
    const side = Math.random() < 0.5 ? -1 : 1;
    s.x = side * (2.8 + Math.random() * 7);
    s.y = 0.3 + Math.random() * 6;
    s.z = anywhere ? -Math.random() * 100 : -90 - Math.random() * 20;
    return s;
  }

  // ---------- Ringed planet + moon in the sky ----------
  buildPlanet() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    const bands = ['#7a2cff', '#b04dff', '#ff6ad5', '#ff9ad9', '#5b7bff', '#00c8ff', '#7a2cff'];
    bands.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, (i * 256) / bands.length, 256, 256 / bands.length + 1); });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const planet = new THREE.Mesh(new THREE.SphereGeometry(13, 40, 24), new THREE.MeshBasicMaterial({ map: tex, fog: false }));
    planet.position.set(-75, 52, -230);
    planet.rotation.z = 0.35;
    const ring = new THREE.Mesh(new THREE.RingGeometry(17, 25, 64), new THREE.MeshBasicMaterial({
      color: glow(0x00e5ff, 1.2), side: THREE.DoubleSide, transparent: true, opacity: 0.55, fog: false, toneMapped: false,
    }));
    ring.rotation.set(1.25, 0.2, 0.35);
    planet.add(ring);
    this.scene.add(planet);
    this.planet = planet;

    const moon = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe9a8, fog: false }));
    moon.position.set(80, 70, -240);
    this.scene.add(moon);
  }

  shootStar() {
    const len = 14 + Math.random() * 10;
    const geo = new THREE.PlaneGeometry(len, 0.35);
    const c = document.createElement('canvas');
    c.width = 128; c.height = 4;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 128, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 4);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, color: glow(0xffffff, 1.5), toneMapped: false,
    }));
    const dir = Math.random() < 0.5 ? -1 : 1;
    m.position.set(-dir * (40 + Math.random() * 60), 60 + Math.random() * 40, -200);
    m.rotation.z = dir > 0 ? -0.35 : Math.PI + 0.35;
    m.userData.v = new THREE.Vector3(dir * 160, -55, 0);
    m.userData.age = 0;
    this.scene.add(m);
    this.shooting.push(m);
  }

  // ---------- Confetti ----------
  confetti(origin = new THREE.Vector3(0, 4.5, -1), count = 260) {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const vel = [];
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      pos[i * 3] = origin.x + (Math.random() - 0.5) * 6;
      pos[i * 3 + 1] = origin.y + Math.random() * 1.5;
      pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 3;
      tmp.setHex(RAINBOW[i % RAINBOW.length]).multiplyScalar(1.4);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
      vel.push(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 2));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.11, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    }));
    this.scene.add(pts);
    this.confettis.push({ pts, vel, age: 0, seed: Math.random() * 10 });
  }

  // ---------- Frame ----------
  update(dt, scroll, pulse, beatCount) {
    this.time += dt;
    const move = scroll * dt;

    const archLoop = this.arches.length * this.archSpacing;
    for (const a of this.arches) {
      a.position.z += move;
      if (a.position.z > 6) a.position.z -= archLoop;
      const far = Math.min(1, Math.max(0, (-a.position.z - 4) / 150));
      for (const m of a.userData.mats) m.opacity = (1 - far) * (0.65 + pulse * 0.35);
    }

    const palmLoop = 12 * this.palmSpacing;
    for (const p of this.palms) {
      p.position.z += move;
      if (p.position.z > 8) p.position.z -= palmLoop;
      p.rotation.z = Math.sin(this.time * 0.8 + p.position.x) * 0.03;
    }

    const gemLoop = this.gems.length * this.gemSpacing;
    for (const g of this.gems) {
      g.position.z += move;
      if (g.position.z > 6) g.position.z -= gemLoop;
      g.rotation.y += dt * g.userData.spin;
      g.rotation.x += dt * g.userData.spin * 0.5;
      g.position.y = g.userData.baseY + Math.sin(this.time * 1.6 + g.position.x) * 0.25;
      g.scale.setScalar(1 + pulse * 0.25);
    }

    this.planet.rotation.y += dt * 0.05;

    const fast = Math.min(1, Math.max(0, (scroll - 15) / 13));
    this.streakLines.material.opacity = fast * 0.75;
    if (fast > 0) {
      const len = 1.5 + scroll * 0.18;
      const arr = this.streakLines.geometry.attributes.position.array;
      this.streaks.forEach((st, i) => {
        st.z += scroll * 1.8 * dt;
        if (st.z > 5) this.newStreak(st);
        arr.set([st.x, st.y, st.z, st.x, st.y, st.z - len], i * 6);
      });
      this.streakLines.geometry.attributes.position.needsUpdate = true;
    }

    this.nextShoot -= dt;
    if (this.nextShoot <= 0) { this.shootStar(); this.nextShoot = 3 + Math.random() * 5; }
    this.shooting = this.shooting.filter(s => {
      s.userData.age += dt;
      s.position.addScaledVector(s.userData.v, dt);
      s.material.opacity = Math.max(0, 1 - s.userData.age / 1.4);
      if (s.userData.age > 1.4) {
        this.scene.remove(s); s.geometry.dispose(); s.material.map.dispose(); s.material.dispose();
        return false;
      }
      return true;
    });

    this.confettis = this.confettis.filter(c => {
      c.age += dt;
      const a = c.pts.geometry.attributes.position;
      for (let i = 0; i < c.vel.length; i++) {
        const v = c.vel[i];
        v.y = Math.max(v.y - 5 * dt, -1.6); // flutter down slowly
        a.array[i * 3] += (v.x + Math.sin(this.time * 4 + i) * 0.8) * dt;
        a.array[i * 3 + 1] += v.y * dt;
        a.array[i * 3 + 2] += v.z * dt;
      }
      a.needsUpdate = true;
      c.pts.material.opacity = Math.min(1, Math.max(0, (3.2 - c.age) / 0.8));
      if (c.age > 3.2) {
        this.scene.remove(c.pts); c.pts.geometry.dispose(); c.pts.material.dispose();
        return false;
      }
      return true;
    });
  }
}
