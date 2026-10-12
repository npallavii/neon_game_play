import { World, SPEED } from './world.js';
import { AudioEngine, TRACKS } from './audio.js';
import { generateBeatmap } from './beatmap.js';
import { PoseTracker, Calibrator, VirtualBody, BodyMapper, toBody, drawCamSkeleton } from './pose.js';
import { Coach } from './coach.js';
import { detectAll, POSES, GUARD, COACH_TEXT, clonePose, lerpPose } from './moves.js';

const $ = id => document.getElementById(id);

// ---------------- Tuning ----------------
const POSE_LATENCY = 0.08;  // camera + model delay compensation (s)
const EARLY = 0.35;         // how early a move may count (s)
const LATE = 0.35;          // how late a move may count (s)
const MEMORY = 0.15;        // a move detected this recently still counts (catches quick punches between frames)
const GRADES = [['perfect', 0.12, 300], ['great', 0.22, 200], ['good', Infinity, 100]];
const SPAWN_DISTANCE = 75;  // metres ahead where blocks appear

// ---------------- Core objects ----------------
let world;
try {
  world = new World($('world'));
} catch (e) {
  showError('Could not start 3D graphics (WebGL). Try Chrome or Edge with hardware acceleration enabled.');
  throw e;
}
let audio = null; // created on the first click (browsers require a user gesture)
const tracker = new PoseTracker($('video'));
const calibrator = new Calibrator();
const virtual = new VirtualBody();
const coach = new Coach($('coachCanvas'), $('coachLabel'));

const settings = { mode: 'camera', trackId: TRACKS[0].id };
let customBuffer = null;
let customName = '';
let state = 'menu'; // menu | loading | calibrate | play | paused | results
let calib = null;
let mapper = null; // pixel -> body space, adapts to distance from the camera
let game = null;
let pendingSong = null;
let resumeAfterCalib = false;

// ---------------- Storage helpers ----------------
const bestKey = id => `neonpulse.best.${id}.${settings.mode}`;
function getBest(id) {
  try { return Number(localStorage.getItem(bestKey(id))) || 0; } catch { return 0; }
}
function setBest(id, v) {
  try { localStorage.setItem(bestKey(id), String(v)); } catch { /* storage unavailable */ }
}

// ---------------- Menu ----------------
function buildTracks() {
  const wrap = $('tracks');
  wrap.innerHTML = '';
  const cards = [...TRACKS, { id: 'custom', name: 'Your Song', bpm: null, diff: 'any', color: '#39ff88', desc: 'Load your own music' }];
  for (const t of cards) {
    const b = document.createElement('button');
    b.className = 'track' + (t.id === settings.trackId ? ' active' : '');
    b.style.setProperty('--c', t.color);
    const best = t.id !== 'custom' ? getBest(t.id) : 0;
    const mins = t.bars ? `${Math.round((t.bars * 4 * 60) / t.bpm / 6) / 10} min` : '';
    b.innerHTML = `
      <div class="t-name">${t.name}</div>
      <div class="t-meta">${t.desc}${t.bpm ? ` · ${t.bpm} BPM · ${mins}` : ''}</div>
      <span class="t-diff">${t.diff.toUpperCase()}</span>
      <div class="t-best">${best ? 'BEST ' + best.toLocaleString() : ''}</div>`;
    b.onclick = () => {
      settings.trackId = t.id;
      $('customPanel').classList.toggle('hidden', t.id !== 'custom');
      buildTracks();
      audio?.sfxUi();
    };
    wrap.appendChild(b);
  }
}

document.querySelectorAll('.mode').forEach(btn => {
  btn.onclick = () => {
    settings.mode = btn.dataset.mode;
    document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b === btn));
    buildTracks();
    audio?.sfxUi();
  };
});

$('customFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  $('customFileName').textContent = 'Loading ' + file.name + '…';
  try {
    audio ??= new AudioEngine();
    customBuffer = await audio.decode(file);
    customName = file.name.replace(/\.[^.]+$/, '');
    $('customFileName').textContent = '🎵 ' + file.name;
  } catch (err) {
    customBuffer = null;
    $('customFileName').textContent = 'Pick an MP3 / audio file…';
    showError('Could not read that audio file. Try an MP3, WAV or OGG.');
  }
};

$('startBtn').onclick = () => startGame();
$('calibCancel').onclick = () => toMenu();
$('resumeBtn').onclick = () => resume();
$('quitBtn').onclick = () => toMenu();
$('recalBtn').onclick = () => recalibrate();
$('againBtn').onclick = () => startGame();
$('menuBtn').onclick = () => toMenu();

function showScreen(id) {
  for (const s of ['menu', 'calib', 'pause', 'results']) $(s).classList.toggle('hidden', s !== id);
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showError.t);
  showError.t = setTimeout(() => el.classList.add('hidden'), 9000);
}

function setCalib(title, text, progress = null) {
  $('calibTitle').textContent = title;
  $('calibText').textContent = text;
  const p = progress ?? 0;
  $('calibRing').style.strokeDashoffset = String(276.5 * (1 - p));
  $('calibPct').textContent = progress == null ? '…' : Math.round(p * 100) + '%';
}

// ---------------- Game flow ----------------
function songFromSettings() {
  if (settings.trackId !== 'custom') return TRACKS.find(t => t.id === settings.trackId);
  if (!customBuffer) {
    showError('Pick an audio file for "Your Song" first.');
    return null;
  }
  const bpm = Math.min(220, Math.max(50, Number($('customBpm').value) || 120));
  const diff = $('customDiff').value;
  return {
    id: 'custom', name: customName, bpm, buffer: customBuffer,
    offset: Math.max(0, Number($('customOffset').value) || 0),
    diff, approach: { easy: 2.3, medium: 2.0, hard: 1.7 }[diff],
  };
}

async function startGame() {
  const song = songFromSettings();
  if (!song) return;
  pendingSong = song;
  try {
    audio ??= new AudioEngine();
    await audio.resume();
    audio.sfxUi();
    await document.fonts.load('900 34px Orbitron').catch(() => {});

    if (settings.mode === 'camera') {
      state = 'loading';
      showScreen('calib');
      setCalib('Starting camera…', 'Allow camera access when your browser asks.');
      await tracker.init((title, text) => setCalib(title, text));
      if (state !== 'loading') return; // user cancelled
      $('cam').classList.remove('hidden');
      calib = null;
      resumeAfterCalib = false;
      calibrator.reset();
      state = 'calibrate';
    } else {
      $('cam').classList.add('hidden');
      beginSong();
    }
  } catch (e) {
    console.error(e);
    const msg = e?.name === 'NotAllowedError'
      ? 'Camera permission was blocked. Click the camera icon in the address bar to allow it, or play in Keyboard mode.'
      : e?.name === 'NotFoundError'
        ? 'No webcam found. Plug one in, or play in Keyboard mode.'
        : 'Could not start: ' + (e?.message || e);
    showError(msg);
    toMenu();
  }
}

function recalibrate() {
  if (settings.mode !== 'camera') return resume();
  calib = null;
  calibrator.reset();
  resumeAfterCalib = true;
  state = 'calibrate';
  showScreen('calib');
}

function beginSong() {
  const song = pendingSong;
  let totalBeats;
  const offset = song.offset || 0;
  if (song.buffer) {
    audio.playBuffer(song.buffer);
    totalBeats = Math.floor(((song.buffer.duration - offset) * song.bpm) / 60);
  } else {
    audio.playSynth(song);
    totalBeats = song.bars * 4;
  }
  const notes = generateBeatmap({ bpm: song.bpm, offset, totalBeats, difficulty: song.diff });
  world.clearNotes();
  world.speed = 44 / song.approach;
  game = {
    song, notes, offset,
    spb: 60 / song.bpm,
    duration: audio.duration,
    next: 0,
    score: 0, combo: 0, maxCombo: 0,
    counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    points: 0,
    lastBeat: -99,
    lostSince: null,
    lastTrue: {}, // move -> last song time it was detected
  };
  $('trackName').textContent = song.name.toUpperCase();
  updateHud(true);
  showScreen(null);
  $('hud').classList.remove('hidden');
  $('coach').classList.remove('hidden');
  state = 'play';
}

function pause() {
  if (state !== 'play') return;
  state = 'paused';
  audio.ctx.suspend();
  showScreen('pause');
  $('recalBtn').classList.toggle('hidden', settings.mode !== 'camera');
}

async function resume() {
  if (!game) return toMenu();
  showScreen(null);
  state = 'play';
  await audio.ctx.resume();
}

function toMenu() {
  state = 'menu';
  if (audio) {
    audio.stop();
    audio.ctx.resume();
  }
  game = null;
  world.clearNotes();
  $('hud').classList.add('hidden');
  $('coach').classList.add('hidden');
  $('cam').classList.add('hidden');
  $('warning').classList.add('hidden');
  buildTracks();
  showScreen('menu');
}

function finish() {
  state = 'results';
  const g = game;
  audio.stop();
  world.clearNotes();
  $('hud').classList.add('hidden');
  $('coach').classList.add('hidden');
  $('warning').classList.add('hidden');

  const total = g.notes.length || 1;
  const acc = g.points / (300 * total);
  const grade = acc >= 0.92 ? 'S' : acc >= 0.8 ? 'A' : acc >= 0.65 ? 'B' : acc >= 0.5 ? 'C' : 'D';
  $('grade').textContent = grade;
  $('resTrack').textContent = g.song.name.toUpperCase();
  $('resScore').textContent = g.score.toLocaleString();
  $('sPerfect').textContent = g.counts.perfect;
  $('sGreat').textContent = g.counts.great;
  $('sGood').textContent = g.counts.good;
  $('sMiss').textContent = g.counts.miss;
  $('sCombo').textContent = g.maxCombo;
  $('sAcc').textContent = Math.round(acc * 100) + '%';
  if (g.song.id !== 'custom') {
    const best = getBest(g.song.id);
    if (g.score > best) {
      setBest(g.song.id, g.score);
      $('resBest').textContent = best ? '★ NEW BEST! ★' : '★ FIRST CLEAR! ★';
    } else {
      $('resBest').textContent = 'Best: ' + best.toLocaleString();
    }
  } else $('resBest').textContent = '';
  showScreen('results');
}

// ---------------- Gameplay ----------------
function popup(text, cls, pos) {
  const d = document.createElement('div');
  d.className = 'pop ' + cls;
  d.textContent = text;
  d.style.left = pos.x + 'px';
  d.style.top = pos.y + 'px';
  $('popups').appendChild(d);
  setTimeout(() => d.remove(), 720);
}

function showBig(text) {
  const el = $('bigText');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth; // restart animation
  el.classList.add('show');
}

function judge(note, grade, pts = 0) {
  const g = game;
  note.judged = true;
  const where = world.toScreen(note.target);
  if (grade === 'miss') {
    g.combo = 0;
    g.counts.miss++;
    world.missNote(note);
    audio.sfxMiss();
    popup('MISS', 'miss', where);
    const v = $('vignette');
    v.classList.add('hurt');
    setTimeout(() => v.classList.remove('hurt'), 180);
  } else {
    g.combo++;
    g.maxCombo = Math.max(g.maxCombo, g.combo);
    const mult = Math.min(4, 1 + Math.floor(g.combo / 10));
    g.score += pts * mult;
    g.points += pts;
    g.counts[grade]++;
    world.hitNote(note, grade);
    audio.sfxHit(grade);
    popup(grade.toUpperCase() + '!', grade, where);
    if (g.combo % 25 === 0) showBig(g.combo + ' COMBO!');
    const c = $('combo');
    c.classList.add('bump');
    setTimeout(() => c.classList.remove('bump'), 90);
  }
  updateHud();
}

let hudCache = {};
function updateHud(force) {
  const g = game;
  const mult = Math.min(4, 1 + Math.floor(g.combo / 10));
  const vals = { score: g.score.toLocaleString(), combo: String(g.combo), mult: 'x' + mult };
  for (const k in vals) {
    if (force || hudCache[k] !== vals[k]) { $(k).textContent = vals[k]; hudCache[k] = vals[k]; }
  }
}

function updateGame(dt, body, px) {
  const g = game;
  const t = audio.songTime();
  const beatPos = (t - g.offset) / g.spb;
  const beatPhase = beatPos >= 0 ? beatPos - Math.floor(beatPos) : null;

  // Countdown during the intro
  const beatIdx = Math.floor(beatPos);
  if (beatIdx !== g.lastBeat) {
    g.lastBeat = beatIdx;
    if (beatIdx >= 4 && beatIdx <= 7) showBig(['3', '2', '1', 'GO!'][beatIdx - 4]);
  }

  // Spawn blocks
  const lead = SPAWN_DISTANCE / world.speed;
  while (g.next < g.notes.length && g.notes[g.next].time - t <= lead) {
    world.spawnNote(g.notes[g.next++]);
  }

  // Judge
  const camera = settings.mode === 'camera';
  const jt = camera ? t - POSE_LATENCY : t;
  const base = camera ? calib : virtual.base;
  const active = detectAll(body, base);
  for (const m of active) g.lastTrue[m] = jt;
  showDetected(active);
  const used = new Set();
  for (const note of world.notes) {
    if (note.judged) continue;
    const d = jt - note.time;
    if (d < -EARLY) continue;
    const seen = g.lastTrue[note.move];
    const hit = !used.has(note.move) && seen != null && jt - seen <= MEMORY && seen >= note.time - EARLY;
    if (hit) {
      used.add(note.move);
      const ad = Math.abs(seen - note.time);
      const [grade, , pts] = GRADES.find(([, w]) => ad <= w);
      judge(note, grade, pts);
    } else if (d > LATE) {
      judge(note, 'miss');
    }
  }
  world.updateNotes(t);
  coach.update(dt, g.notes, t, g.spb, beatPhase);
  $('progressFill').style.width = Math.min(100, (t / g.duration) * 100) + '%';

  // Tracking-lost warning
  if (camera) {
    if (!px) g.lostSince ??= t; else g.lostSince = null;
    $('warning').classList.toggle('hidden', !(g.lostSince != null && t - g.lostSince > 0.6));
  }

  if (t >= g.duration + 0.3) finish();
  return beatPhase;
}

function handleCalibration(px) {
  const c = calibrator.add(px);
  setCalib('Get in position',
    (calibrator.message || 'Stand with your whole body in view') + '. Arms relaxed at your sides.',
    calibrator.progress);
  if (!c) return;
  calib = c;
  mapper = new BodyMapper(c);
  audio.sfxHit('perfect');
  if (resumeAfterCalib && game) {
    resumeAfterCalib = false;
    resume();
  } else {
    beginSong();
  }
}

// Live indicator of what the camera currently recognises
let detectedText = null;
function showDetected(active) {
  const text = active.length ? active.map(m => COACH_TEXT[m]).join(' · ') : '—';
  if (text === detectedText) return;
  detectedText = text;
  $('detectedMoves').textContent = text;
  $('detected').classList.toggle('on', active.length > 0);
}

// Menu background: avatar dancing through the moves
const demo = { pose: clonePose(GUARD), t: 0, seq: ['PL', 'PR', 'HL', 'HR', 'UP', 'KL', 'KR', 'DUCK', 'JUMP', 'DL', 'DR', 'UP'] };
function demoUpdate(dt) {
  demo.t += dt;
  const beat = demo.t / 0.6;
  const i = Math.floor(beat / 2) % demo.seq.length;
  const target = beat % 2 < 1 ? POSES[demo.seq[i]] : GUARD;
  lerpPose(demo.pose, target, 1 - Math.exp(-dt * 12));
  return beat % 1;
}

// ---------------- Input ----------------
window.addEventListener('keydown', e => {
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (state === 'play') { pause(); return; }
    if (state === 'paused') { resume(); return; }
  }
  if (state === 'menu' && e.code === 'Enter') { startGame(); return; }
  if (state === 'play' && settings.mode === 'keyboard') {
    if (virtual.keydown(e.code, performance.now())) e.preventDefault();
  }
});
window.addEventListener('keyup', e => virtual.keyup(e.code));
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// ---------------- Main loop ----------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  let px = null;
  let body = null;
  if (settings.mode === 'camera' && tracker.ready && state !== 'menu') {
    px = tracker.update(now);
    drawCamSkeleton($('camOverlay'), px, tracker.width, tracker.height);
  }

  let beatPhase = null;
  let scroll = 6;
  switch (state) {
    case 'menu':
    case 'results':
    case 'loading':
      beatPhase = demoUpdate(dt);
      body = demo.pose;
      break;
    case 'calibrate': {
      handleCalibration(px);
      // live preview using the current frame as a temporary calibration
      if (px && px.lSh && px.rSh) {
        const sw = Math.hypot(px.lSh.x - px.rSh.x, px.lSh.y - px.rSh.y);
        body = toBody(px, { cx: (px.lSh.x + px.rSh.x) / 2, cy: (px.lSh.y + px.rSh.y) / 2, sw: Math.max(sw, 1) });
      }
      coach.idle(dt, 'STAND STILL');
      break;
    }
    case 'play':
      body = settings.mode === 'camera' ? mapper?.map(px) ?? null : virtual.update(dt, now);
      beatPhase = updateGame(dt, body, px);
      scroll = world.speed;
      break;
    case 'paused':
      body = settings.mode === 'camera' ? mapper?.map(px) ?? null : virtual.pose;
      scroll = 0;
      break;
  }
  if (state === 'results') body = demo.pose;
  world.setAvatar(body);
  world.update(state === 'paused' ? 0 : dt, beatPhase, scroll);
}

buildTracks();
requestAnimationFrame(frame);

// handy for debugging in the browser console
window.neonDebug = { state: () => state, game: () => game, time: () => audio?.songTime() };
