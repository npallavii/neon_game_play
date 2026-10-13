import { World } from './world.js';
import { AudioEngine, TRACKS, linearTempo } from './audio.js';
import { generateBeatmap } from './beatmap.js';
import { PoseTracker, Calibrator, VirtualBody, BodyMapper, toBody, drawCamSkeleton, KEYS_P1, KEYS_P2 } from './pose.js';
import { Coach } from './coach.js';
import { detectAll, POSES, GUARD, COACH_TEXT, clonePose, lerpPose } from './moves.js';

const $ = id => document.getElementById(id);

// ---------------- Tuning ----------------
const CAMERA_LATENCY = 0.04; // camera capture delay (s); model delay is measured live
const EARLY = 0.35;         // how early a move may count (s)
const LATE = 0.35;          // how late a move may count (s)
const MEMORY = 0.15;        // a move detected this recently still counts (catches quick punches between frames)
const GRADES = [['perfect', 0.12, 300], ['great', 0.22, 200], ['good', Infinity, 100]];
const SPAWN_DISTANCE = 75;  // metres ahead where blocks appear
// Like an endless runner: the run starts slow and keeps getting faster.
const SPEED_START = 13;     // metres / second at the start
const SPEED_END = 30;       // metres / second at the end
const SPEED_LEVELS = 5;     // "SPEED UP!" moments during a run

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
const coach = new Coach($('coachCanvas'), $('coachLabel'));

// Per-player things that live across games (index 0 = Player 1 / left, 1 = Player 2 / right)
const seats = [KEYS_P1, KEYS_P2].map(keys => ({
  calibrator: new Calibrator(),
  virtual: new VirtualBody(keys),
  calib: null,
  mapper: null,   // pixel -> body space, adapts to distance from the camera
  shown: {},      // eased pose for drawing
  shownValid: false,
}));

const settings = { mode: 'camera', trackId: TRACKS[0].id, players: 1 };
let customBuffer = null;
let customName = '';
let state = 'menu'; // menu | loading | calibrate | play | paused | results
let game = null;
let pendingSong = null;
let resumeAfterCalib = false;

const nPlayers = () => settings.players;
const isTwo = () => settings.players === 2;

// ---------------- Storage helpers ----------------
const bestKey = id => `neonpulse.best.${id}.${settings.mode}`;
function getBest(id) {
  try { return Number(localStorage.getItem(bestKey(id))) || 0; } catch { return 0; }
}
function setBest(id, v) {
  try { localStorage.setItem(bestKey(id), String(v)); } catch { /* storage unavailable */ }
}

// ---------------- Menu ----------------
/** Length of a built-in track, including its tempo ramp (same formula as the music engine). */
function trackSeconds(t) {
  let sec = 0;
  for (let b = 0; b < t.bars; b++) {
    const k = Math.min(1, Math.max(0, (b - 2) / (t.bars - 8)));
    sec += 240 / (t.bpm + ((t.bpmEnd ?? t.bpm) - t.bpm) * k);
  }
  return sec;
}
function buildTracks() {
  const wrap = $('tracks');
  wrap.innerHTML = '';
  const cards = [...TRACKS, { id: 'custom', name: 'Your Song', bpm: null, diff: 'any', color: '#39ff88', desc: 'Load your own music' }];
  for (const t of cards) {
    const b = document.createElement('button');
    b.className = 'track' + (t.id === settings.trackId ? ' active' : '');
    b.style.setProperty('--c', t.color);
    const best = t.id !== 'custom' ? getBest(t.id) : 0;
    const mins = t.bars ? `${Math.round(trackSeconds(t) / 6) / 10} min` : '';
    const bpm = t.bpmEnd ? `${t.bpm}→${t.bpmEnd} BPM` : t.bpm ? `${t.bpm} BPM` : '';
    b.innerHTML = `
      <div class="t-name">${t.name}</div>
      <div class="t-meta">${t.desc}${t.bpm ? ` · ${bpm} · ${mins}` : ''}</div>
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

document.querySelectorAll('.mode[data-mode]').forEach(btn => {
  btn.onclick = () => {
    settings.mode = btn.dataset.mode;
    document.querySelectorAll('.mode[data-mode]').forEach(b => b.classList.toggle('active', b === btn));
    buildTracks();
    audio?.sfxUi();
  };
});

document.querySelectorAll('.mode[data-players]').forEach(btn => {
  btn.onclick = () => {
    settings.players = Number(btn.dataset.players);
    document.querySelectorAll('.mode[data-players]').forEach(b => b.classList.toggle('active', b === btn));
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
$('againBtn2').onclick = () => startGame();
$('menuBtn2').onclick = () => toMenu();

function showScreen(id) {
  for (const s of ['menu', 'calib', 'pause', 'results', 'results2']) $(s).classList.toggle('hidden', s !== id);
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

/** Put the shared track/progress/speed block into the right HUD for 1 or 2 players. */
function layoutHud() {
  document.body.classList.toggle('two', isTwo());
  const shared = $('hudShared');
  if (isTwo()) $('hud2Center').appendChild(shared);
  else $('hud').appendChild(shared);
  world.setPlayers(nPlayers());
}

function hideHud() {
  for (const id of ['hud', 'hud2', 'coach', 'warning']) $(id).classList.add('hidden');
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
    diff,
  };
}

async function startGame() {
  const song = songFromSettings();
  if (!song) return;
  pendingSong = song;
  layoutHud();
  try {
    audio ??= new AudioEngine();
    await audio.resume();
    audio.sfxUi();
    await document.fonts.load('900 34px Orbitron').catch(() => {});

    if (settings.mode === 'camera') {
      state = 'loading';
      showScreen('calib');
      setCalib('Starting camera…', 'Allow camera access when your browser asks.');
      tracker.setPlayers(nPlayers());
      await tracker.init((title, text) => setCalib(title, text));
      if (state !== 'loading') return; // user cancelled
      $('cam').classList.remove('hidden');
      startCalibration(false);
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

function startCalibration(resumeAfter) {
  for (const s of seats) { s.calib = null; s.mapper = null; s.calibrator.reset(); }
  resumeAfterCalib = resumeAfter;
  state = 'calibrate';
  showScreen('calib');
}

function recalibrate() {
  if (settings.mode !== 'camera') return resume();
  startCalibration(true);
}

function newPlayerStats() {
  return {
    score: 0, combo: 0, maxCombo: 0, points: 0,
    counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    lastTrue: {},   // move -> last song time it was detected
    lostSince: null,
  };
}

function beginSong() {
  const song = pendingSong;
  let totalBeats, tempo;
  const offset = song.offset || 0;
  if (song.buffer) {
    audio.playBuffer(song.buffer);
    totalBeats = Math.floor(((song.buffer.duration - offset) * song.bpm) / 60);
    tempo = linearTempo(song.bpm, offset);
  } else {
    audio.playSynth(song);
    totalBeats = song.bars * 4;
    tempo = audio.tempo;
  }
  const base = generateBeatmap({ timeOf: tempo.timeOf, totalBeats, difficulty: song.diff });
  // Every player gets the same choreography in their own lane.
  const notes = [];
  for (const n of base) {
    for (let p = 0; p < nPlayers(); p++) notes.push({ ...n, id: n.id * 2 + p, player: p });
  }
  world.clearNotes();
  world.prewarm();
  world.speed = SPEED_START;
  game = {
    song, notes, base, tempo,
    rampStart: tempo.timeOf(8),
    rampEnd: base.length ? base[base.length - 1].time : audio.duration,
    level: 1,
    duration: audio.duration,
    next: 0,
    lastBeat: -99,
    players: Array.from({ length: nPlayers() }, newPlayerStats),
  };
  for (const s of seats) s.shownValid = false;
  $('trackName').textContent = song.name.toUpperCase();
  updateHud(true);
  updateSpeedMeter(1, 1);
  showScreen(null);
  $(isTwo() ? 'hud2' : 'hud').classList.remove('hidden');
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
  audio.resetClock();
}

function toMenu() {
  state = 'menu';
  if (audio) {
    audio.stop();
    audio.ctx.resume();
  }
  game = null;
  world.clearNotes();
  hideHud();
  $('cam').classList.add('hidden');
  document.body.classList.remove('two');
  world.setPlayers(1);
  buildTracks();
  showScreen('menu');
}

const accuracy = (pl, total) => pl.points / (300 * (total || 1));
const starCount = acc => (acc >= 0.85 ? 3 : acc >= 0.65 ? 2 : acc >= 0.35 ? 1 : 0);

function finish() {
  state = 'results';
  const g = game;
  audio.stop();
  world.clearNotes();
  hideHud();
  if (isTwo()) return finishVersus();

  const pl = g.players[0];
  const acc = accuracy(pl, g.base.length);
  const grade = acc >= 0.92 ? 'S' : acc >= 0.8 ? 'A' : acc >= 0.65 ? 'B' : acc >= 0.5 ? 'C' : 'D';
  $('grade').textContent = grade;
  const stars = starCount(acc);
  document.querySelectorAll('#stars .star').forEach((el, i) => {
    el.classList.toggle('on', i < stars);
    el.style.animationDelay = 0.25 + i * 0.3 + 's';
  });
  $('resMsg').textContent = [
    "Good try! Let's go again! 💪",
    'Nice moves! Keep going! 🙌',
    'Awesome workout! ⚡',
    "You're a SUPERSTAR! 🌟",
  ][stars];
  if (stars >= 2) { world.confetti(); setTimeout(() => world.confetti(), 700); }
  $('resTrack').textContent = g.song.name.toUpperCase();
  $('resScore').textContent = pl.score.toLocaleString();
  $('sPerfect').textContent = pl.counts.perfect;
  $('sGreat').textContent = pl.counts.great;
  $('sGood').textContent = pl.counts.good;
  $('sMiss').textContent = pl.counts.miss;
  $('sCombo').textContent = pl.maxCombo;
  $('sAcc').textContent = Math.round(acc * 100) + '%';
  if (g.song.id !== 'custom') {
    const best = getBest(g.song.id);
    if (pl.score > best) {
      setBest(g.song.id, pl.score);
      $('resBest').textContent = best ? '★ NEW BEST! ★' : '★ FIRST CLEAR! ★';
    } else {
      $('resBest').textContent = 'Best: ' + best.toLocaleString();
    }
  } else $('resBest').textContent = '';
  showScreen('results');
}

function finishVersus() {
  const g = game;
  const [a, b] = g.players;
  const winner = a.score === b.score ? -1 : a.score > b.score ? 0 : 1;
  $('winner').textContent = winner < 0 ? "IT'S A TIE! 🤝" : `PLAYER ${winner + 1} WINS! 🏆`;
  $('resTrack2').textContent = g.song.name.toUpperCase();
  g.players.forEach((pl, i) => {
    const n = i + 1;
    const acc = accuracy(pl, g.base.length);
    const stars = starCount(acc);
    $(`r${n}stars`).innerHTML = [0, 1, 2].map(k => `<span class="${k < stars ? 'on' : 'off'}">★</span>`).join('');
    $(`r${n}score`).textContent = pl.score.toLocaleString();
    $(`r${n}perfect`).textContent = pl.counts.perfect;
    $(`r${n}great`).textContent = pl.counts.great;
    $(`r${n}good`).textContent = pl.counts.good;
    $(`r${n}miss`).textContent = pl.counts.miss;
    $(`r${n}combo`).textContent = pl.maxCombo;
    $(`r${n}acc`).textContent = Math.round(acc * 100) + '%';
    document.querySelector(`.duo-col.p${n}`).classList.toggle('win', winner === i);
  });
  world.confetti();
  setTimeout(() => world.confetti(), 700);
  setTimeout(() => world.confetti(), 1400);
  showScreen('results2');
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

const PRAISE = {
  perfect: ['PERFECT! ⭐', 'AMAZING! ⭐', 'WOW! ⭐', 'SUPER! ⭐'],
  great: ['GREAT!', 'NICE!', 'COOL!', 'YEAH!'],
  good: ['GOOD!', 'OK!'],
};
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function showBig(text) {
  const el = $('bigText');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth; // restart animation
  el.classList.add('show');
}

function judge(note, grade, pts = 0) {
  const pl = game.players[note.player];
  note.judged = true;
  const where = world.toScreen(note.target);
  if (grade === 'miss') {
    pl.combo = 0;
    pl.counts.miss++;
    world.missNote(note);
    audio.sfxMiss();
    popup(pick(['OOPS!', 'MISS', 'TRY AGAIN!']), 'miss', where);
    if (!isTwo()) {
      const v = $('vignette');
      v.classList.add('hurt');
      setTimeout(() => v.classList.remove('hurt'), 180);
    }
  } else {
    pl.combo++;
    pl.maxCombo = Math.max(pl.maxCombo, pl.combo);
    const mult = Math.min(4, 1 + Math.floor(pl.combo / 10));
    pl.score += pts * mult;
    pl.points += pts;
    pl.counts[grade]++;
    world.hitNote(note, grade);
    world.cheer(note.player);
    audio.sfxHit(grade);
    popup(pick(PRAISE[grade]), grade, where);
    if (pl.combo % 10 === 0) {
      showBig(isTwo() ? `P${note.player + 1} 🔥 ${pl.combo} COMBO!` : `🔥 ${pl.combo} COMBO!`);
      world.confetti();
    }
    const c = isTwo() ? $(`p${note.player + 1}combo`) : $('combo');
    c.classList.add('bump');
    setTimeout(() => c.classList.remove('bump'), 90);
  }
  updateHud();
}

let speedCache = '';
function updateSpeedMeter(level, mult) {
  const key = level + ':' + mult.toFixed(1);
  if (key === speedCache) return;
  speedCache = key;
  $('speedVal').textContent = 'x' + mult.toFixed(1);
  document.querySelectorAll('#speedBars i').forEach((el, i) => el.classList.toggle('on', i < level));
}

let hudCache = {};
function setText(id, text, force) {
  if (force || hudCache[id] !== text) { $(id).textContent = text; hudCache[id] = text; }
}
function updateHud(force) {
  const ps = game.players;
  const mult = pl => 'x' + Math.min(4, 1 + Math.floor(pl.combo / 10));
  if (!isTwo()) {
    setText('score', ps[0].score.toLocaleString(), force);
    setText('combo', String(ps[0].combo), force);
    setText('mult', mult(ps[0]), force);
    return;
  }
  ps.forEach((pl, i) => {
    setText(`p${i + 1}score`, pl.score.toLocaleString(), force);
    setText(`p${i + 1}combo`, String(pl.combo), force);
    setText(`p${i + 1}mult`, mult(pl), force);
  });
  const lead = ps[0].score === ps[1].score ? -1 : ps[0].score > ps[1].score ? 0 : 1;
  $('crown1').classList.toggle('on', lead === 0);
  $('crown2').classList.toggle('on', lead === 1);
}

/** bodies[i]: player i's body-space pose (or null); pxs[i]: their raw camera landmarks */
function updateGame(dt, bodies, pxs) {
  const g = game;
  const t = audio.songTime();
  const beatPos = g.tempo.beatAt(t);
  const spb = 60 / g.tempo.bpmAt(t);

  // Speed ramps up through the run, with a "SPEED UP!" moment at each level
  const ramp = Math.min(1, Math.max(0, (t - g.rampStart) / (g.rampEnd - g.rampStart)));
  world.speed = SPEED_START + (SPEED_END - SPEED_START) * ramp;
  const level = Math.min(SPEED_LEVELS, 1 + Math.floor(ramp * SPEED_LEVELS + 1e-6));
  if (level > g.level) {
    g.level = level;
    showBig('⚡ SPEED UP! ⚡');
    audio.sfxWhoosh();
    world.boost();
  }
  updateSpeedMeter(level, world.speed / SPEED_START);
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

  // What is each player doing right now?
  const camera = settings.mode === 'camera';
  const jt = camera ? t - Math.min(0.25, CAMERA_LATENCY + tracker.latency) : t;
  g.players.forEach((pl, i) => {
    const base = camera ? seats[i].calib : seats[i].virtual.base;
    const active = detectAll(bodies[i], base);
    for (const m of active) pl.lastTrue[m] = jt;
    if (i === 0 && !isTwo()) showDetected(active);
  });

  // Judge
  const used = g.players.map(() => new Set());
  for (const note of world.notes) {
    if (note.judged) continue;
    const pl = g.players[note.player];
    const d = jt - note.time;
    if (d < -EARLY) continue;
    const seen = pl.lastTrue[note.move];
    const hit = !used[note.player].has(note.move) && seen != null && jt - seen <= MEMORY && seen >= note.time - EARLY;
    if (hit) {
      used[note.player].add(note.move);
      const ad = Math.abs(seen - note.time);
      const [grade, , pts] = GRADES.find(([, w]) => ad <= w);
      judge(note, grade, pts);
    } else if (d > LATE) {
      judge(note, 'miss');
    }
  }
  world.updateNotes(t);
  coach.update(dt, g.base, t, spb, beatPhase);
  $('progressFill').style.transform = `scaleX(${Math.min(1, Math.max(0, t / g.duration))})`;

  // Tracking-lost warning
  if (camera) {
    const lost = [];
    g.players.forEach((pl, i) => {
      if (!pxs[i]) pl.lostSince ??= t; else pl.lostSince = null;
      if (pl.lostSince != null && t - pl.lostSince > 0.6) lost.push(i);
    });
    $('warning').classList.toggle('hidden', !lost.length);
    if (lost.length) {
      $('warning').textContent = isTwo()
        ? lost.map(i => `PLAYER ${i + 1}`).join(' & ') + ': STEP INTO VIEW'
        : 'STEP INTO THE CAMERA VIEW';
    }
  }

  if (t >= g.duration + 0.3) finish();
  return beatPhase;
}

function handleCalibration(pxs) {
  let done = 0;
  const msgs = [];
  let progress = 1;
  seats.slice(0, nPlayers()).forEach((s, i) => {
    if (!s.calib) {
      const c = s.calibrator.add(pxs[i]);
      if (c) {
        s.calib = c;
        s.mapper = new BodyMapper(c);
        audio.sfxHit('perfect');
      }
    }
    if (s.calib) done++;
    progress = Math.min(progress, s.calib ? 1 : s.calibrator.progress);
    msgs.push(s.calib ? '✓ Ready!' : (s.calibrator.message || 'Stand with your whole body in view'));
  });
  if (isTwo()) {
    setCalib('Get in position',
      `Player 1 (left): ${msgs[0]}  ·  Player 2 (right): ${msgs[1]}. Stand side by side, about 3 m back, arms relaxed.`,
      progress);
  } else {
    setCalib('Get in position', msgs[0] + '. Arms relaxed at your sides.', progress);
  }
  if (done < nPlayers()) return;
  if (resumeAfterCalib && game) {
    resumeAfterCalib = false;
    resume();
  } else {
    beginSong();
  }
}

// Live indicator of what the camera currently recognises (solo mode)
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
    for (const s of seats.slice(0, nPlayers())) {
      if (s.virtual.keydown(e.code, performance.now())) e.preventDefault();
    }
  }
});
window.addEventListener('keyup', e => { for (const s of seats) s.virtual.keyup(e.code); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// The camera gives ~30 poses/s but the screen draws 60+ frames/s. Easing the
// avatar toward the newest pose every frame makes it glide instead of step.
// (Hit detection still uses the real, un-eased pose.)
function smoothForDisplay(seat, body, dt) {
  const shown = seat.shown;
  if (!body) { seat.shownValid = false; return null; }
  const k = seat.shownValid ? 1 - Math.exp(-dt * 28) : 1;
  for (const name in shown) if (!body[name]) delete shown[name];
  for (const name in body) {
    const b = body[name], s = shown[name];
    if (!s) shown[name] = [b[0], b[1]];
    else { s[0] += (b[0] - s[0]) * k; s[1] += (b[1] - s[1]) * k; }
  }
  seat.shownValid = true;
  return shown;
}

/** Temporary body for the calibration preview: centred on the current shoulders. */
function previewBody(px) {
  if (!px || !px.lSh || !px.rSh) return null;
  const sw = Math.hypot(px.lSh.x - px.rSh.x, px.lSh.y - px.rSh.y);
  return toBody(px, { cx: (px.lSh.x + px.rSh.x) / 2, cy: (px.lSh.y + px.rSh.y) / 2, sw: Math.max(sw, 1) });
}

// ---------------- Main loop ----------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const n = nPlayers();
  let pxs = [null, null];
  if (settings.mode === 'camera' && tracker.ready && state !== 'menu') {
    tracker.update(now);
    pxs = tracker.pxAll;
    drawCamSkeleton($('camOverlay'), pxs, tracker.width, tracker.height);
  }
  const camera = settings.mode === 'camera';
  const live = i => (camera ? seats[i].mapper?.map(pxs[i]) ?? null : seats[i].virtual.update(dt, now));

  let bodies = [null, null];
  let beatPhase = null;
  let scroll = 6;
  switch (state) {
    case 'menu':
    case 'results':
    case 'loading':
      beatPhase = demoUpdate(dt);
      bodies = [demo.pose, state === 'menu' || n === 1 ? null : demo.pose];
      break;
    case 'calibrate':
      handleCalibration(pxs);
      bodies = [0, 1].map(i => (i < n ? previewBody(pxs[i]) : null));
      coach.idle(dt, 'STAND STILL');
      break;
    case 'play':
      bodies = [0, 1].map(i => (i < n ? live(i) : null));
      beatPhase = updateGame(dt, bodies, pxs);
      scroll = world.speed;
      break;
    case 'paused':
      bodies = [0, 1].map(i => (i < n ? (camera ? seats[i].mapper?.map(pxs[i]) ?? null : seats[i].virtual.pose) : null));
      scroll = 0;
      break;
  }
  for (let i = 0; i < 2; i++) world.setAvatar(smoothForDisplay(seats[i], bodies[i], dt), i);
  world.update(state === 'paused' ? 0 : dt, beatPhase, scroll);
}

buildTracks();
requestAnimationFrame(frame);

// handy for debugging in the browser console
window.neonDebug = { state: () => state, game: () => game, time: () => audio?.songTime(), tracker, world, settings };
