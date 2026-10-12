// Builds the choreography: a list of { move, beat, time } notes locked to the beat.
// Songs are split into 8-beat phrases; each phrase picks a pattern.
// Pattern entries are [beatOffset, moveId].

const REST = [
  [[0, 'PL'], [4, 'PR']],
  [[0, 'UP'], [4, 'UP']],
  [[0, 'HL'], [4, 'HR']],
];

const EASY = [
  [[0, 'PL'], [2, 'PR'], [4, 'PL'], [6, 'PR']],
  [[0, 'HL'], [2, 'HR'], [4, 'HL'], [6, 'HR']],
  [[0, 'PL'], [2, 'PR'], [4, 'UP']],
  [[0, 'KL'], [2, 'KR'], [4, 'KL'], [6, 'KR']],
  [[0, 'DUCK'], [4, 'DUCK']],
  [[0, 'DL'], [4, 'DR']],
  [[0, 'PL'], [2, 'HL'], [4, 'PR'], [6, 'HR']],
  [[0, 'UP'], [2, 'PL'], [4, 'UP'], [6, 'PR']],
];

const MEDIUM = [
  [[0, 'PL'], [1, 'PR'], [2, 'PL'], [3, 'PR'], [4, 'HL'], [5, 'HR'], [6, 'HL'], [7, 'HR']],
  [[0, 'KL'], [1, 'KR'], [2, 'KL'], [3, 'KR'], [4, 'UP'], [6, 'UP']],
  [[0, 'PL'], [1, 'PR'], [2, 'PL'], [4, 'DUCK'], [6, 'PR']],
  [[0, 'JUMP'], [2, 'JUMP'], [4, 'PL'], [5, 'PR'], [6, 'PL'], [7, 'PR']],
  [[0, 'DL'], [2, 'DR'], [4, 'DL'], [6, 'DR']],
  [[0, 'HL'], [1, 'HR'], [2, 'UP'], [4, 'KL'], [5, 'KR'], [6, 'KL'], [7, 'KR']],
  [[0, 'DUCK'], [2, 'UP'], [4, 'DUCK'], [6, 'UP']],
  [[0, 'PR'], [1, 'PL'], [2, 'HR'], [3, 'HL'], [4, 'JUMP'], [6, 'UP']],
];

const HARD = [
  [[0, 'PL'], [0.5, 'PR'], [1, 'PL'], [2, 'PR'], [2.5, 'PL'], [3, 'PR'], [4, 'DUCK'], [6, 'JUMP']],
  [[0, 'HL'], [0.5, 'HR'], [1, 'HL'], [1.5, 'HR'], [2, 'UP'], [4, 'KL'], [4.5, 'KR'], [5, 'KL'], [5.5, 'KR'], [6, 'DUCK']],
  [[0, 'JUMP'], [1, 'JUMP'], [2, 'JUMP'], [3, 'JUMP'], [4, 'PL'], [4.5, 'PR'], [5, 'PL'], [5.5, 'PR'], [6, 'UP']],
  [[0, 'DL'], [1, 'DR'], [2, 'DL'], [3, 'DR'], [4, 'DUCK'], [5, 'UP'], [6, 'DUCK'], [7, 'UP']],
  [[0, 'PL'], [0.5, 'PR'], [1, 'HL'], [1.5, 'HR'], [2, 'PL'], [2.5, 'PR'], [3, 'UP'], [4, 'KL'], [5, 'KR'], [6, 'JUMP']],
];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * timeOf(beat) -> seconds. difficulty: easy | medium | hard | ramp.
 * "ramp" works like an endless runner: calm at first, busier as the speed rises.
 */
export function generateBeatmap({ timeOf, totalBeats, difficulty, seed = Date.now() }) {
  const rng = mulberry32(seed);
  const startBeat = 8;           // 2 bars of intro / countdown
  const endBeat = totalBeats - 8; // leave room for the outro
  const notes = [];
  let lastPattern = null;
  let phrase = 0;

  for (let b = startBeat; b + 8 <= endBeat; b += 8, phrase++) {
    const progress = (b - startBeat) / Math.max(1, endBeat - startBeat);
    let pool;
    if (difficulty === 'ramp') {
      pool = progress < 0.15 ? REST
        : progress < 0.4 ? EASY
        : progress < 0.65 ? (phrase % 2 ? MEDIUM : EASY)
        : progress < 0.85 ? MEDIUM
        : (phrase % 3 === 2 ? HARD : MEDIUM);
    } else if (difficulty === 'easy') pool = phrase % 4 === 3 ? REST : EASY;
    else if (difficulty === 'medium') pool = progress < 0.2 ? EASY : MEDIUM;
    else pool = progress < 0.15 ? EASY : progress < 0.35 ? MEDIUM : [...MEDIUM, ...HARD, ...HARD];

    let pattern;
    do pattern = pool[Math.floor(rng() * pool.length)];
    while (pool.length > 1 && pattern === lastPattern);
    lastPattern = pattern;

    for (const [off, move] of pattern) {
      const beat = b + off;
      notes.push({ move, beat, time: timeOf(beat) });
    }
  }
  notes.forEach((n, i) => (n.id = i));
  return notes;
}
