# Neon Pulse

A synthwave rhythm-fitness game played in the browser. Your webcam tracks your whole body (Google MediaPipe Pose), and you punch, reach, raise your knees, duck, jump and side-step to hit neon blocks on the beat.

## Run it

1. Double-click **`start.bat`**. It starts a small local server and opens http://localhost:8080.
   - You can also run `python -m http.server 8080` in this folder and open that address yourself.
   - Opening `index.html` directly from the file system **won't work**: browsers block the camera and JS modules on `file://` pages.
2. Use **Chrome or Edge** and allow camera access.
3. Stand about 2–3 m back so your knees are in view, then hold still for the 1.5-second calibration.

You need an internet connection the first time, because Three.js, MediaPipe and the fonts load from CDNs.

## Moves

| Block | What to do | Keyboard (test mode) |
|---|---|---|
| Cyan / pink cube (arrow) | Punch out to that side | A / D |
| Cube with diagonal arrow | Punch up high on that side | Q / E |
| Green KNEE cube | Lift that knee high | Z / C |
| Gold REACH UP bar | Both hands above your head | W |
| Red DUCK beam | Squat under it | S |
| Purple JUMP bar | Jump | Space |
| Orange STEP wall | Step sideways, out of the wall's way | ← / → |

Press **P** or **Esc** to pause. You can re-calibrate from the pause menu.

## Project layout

| File | Purpose |
|---|---|
| `js/main.js` | Game flow, hit judging, scoring, HUD |
| `js/world.js` | Three.js scene: sun, grid, mountains, blocks, avatar, bloom, particles |
| `js/pose.js` | Webcam + MediaPipe tracking, calibration, keyboard stand-in |
| `js/moves.js` | Move definitions, target positions, hit conditions, coach poses |
| `js/beatmap.js` | Choreography patterns → notes on the beat |
| `js/audio.js` | Procedural synthwave tracks + sound effects (Web Audio) |
| `js/coach.js` | The guide figure that demonstrates the next move |

## Tuning

- **Hits feel late or early:** change `POSE_LATENCY`, `EARLY` and `LATE` in `js/main.js`.
- **A move is too hard or too easy to trigger:** change its thresholds in `checkMove()` in `js/moves.js`. Distances there are in shoulder-widths.
- **New choreography:** add patterns to the `EASY`, `MEDIUM` or `HARD` lists in `js/beatmap.js`. Each pattern is a list of `[beatOffset, move]` pairs within 8 beats.
- **Your own music:** pick "Your Song" in the menu and enter its BPM. If the beat feels off, set "First beat" to the time in seconds where the first beat lands.
