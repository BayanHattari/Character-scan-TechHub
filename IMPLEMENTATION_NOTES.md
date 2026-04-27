# Implementation Notes

A working reference for the kiosk app, the wall display, and the server. Covers how each piece fits together, the non-obvious decisions, what we've already changed, and what's still rough. Read this top-to-bottom once; keep it updated as the system evolves.

---

## 1. System overview

Three subprojects in one repo:

- **`kiosk-app/`** — React + Vite. The visitor-facing capture experience: hand-tracked drawing canvas, color wheel, capture button, upload.
- **`wall-display/`** — React + Vite. The grid of all uploaded captures, designed to run on a separate display.
- **`server/`** — Node/Express. Local-LAN backend: stores PNGs on disk, metadata in SQLite, broadcasts new captures via SSE.
- **`air-canvas/`** — standalone HTML/JS gesture-drawing demo. Not used by the kiosk in production; kept as a reference implementation.

Topology at runtime:

```
[ Kiosk PC ]                                      [ Wall-display PC ]
  ├── kiosk-app  (browser)  ──────POST /upload──▶  server
  │                                          ▲       │
  │   server                                 │       └── GET /events  (SSE)
  │     ├── Express + SQLite + sharp         │       └── GET /photos  (poll fallback)
  │     ├── photos/   <id>.png + thumbs/     │
  │     └── data/photos.db                   │
  │                                          │
  └────────────────────── LAN ──────────────┘
```

Internet-free. The two PCs share a Wi-Fi/LAN segment; the wall-display reads `VITE_API_BASE` from its `.env` to find the server.

---

## 2. Server (`server/server.js`)

A single ~190-line Express app. Stateless apart from disk + SQLite.

### Storage

- `server/photos/<id>.png` — full image (PNG, written via `sharp`).
- `server/photos/thumbs/<id>.jpg` — 250×250 cover-cropped thumbnail (JPEG q=80).
- `server/data/photos.db` — `better-sqlite3` file with one table `photos(id, filename, thumb_filename, created_at)`.
- All paths are configurable via env (`PHOTOS_DIR`, `DB_PATH`).
- WAL mode is enabled for concurrent reads while writes are happening.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health-check string. |
| GET | `/photos?limit=N` | Returns `[{id, url, thumbnailUrl, createdAt}]`. URLs are absolute (`${req.protocol}://${req.get('host')}/photos/...`) so the wall-display on a different machine resolves them. |
| POST | `/upload` (field `file`) | Saves PNG + thumbnail, inserts row, broadcasts SSE `photo_uploaded`. |
| GET | `/events` | SSE stream. Sends `{type: "hello"}` on connect, then `{type: "photo_uploaded"\|"photo_deleted", ...}` on changes. |
| DELETE | `/photos/:id` (header `x-admin-key`) | Removes both files from disk + row, broadcasts SSE. |
| GET | `/photos/<file>` | `express.static` over the photos dir, mounted **after** the JSON routes so `GET /photos` and `DELETE /photos/:id` win. |

### Boot

Listens on `HOST:PORT` (defaults `0.0.0.0:3000`). On boot, walks `os.networkInterfaces()` and prints every non-internal IPv4 — that's how the operator gets the URL to put into the wall-display `.env`.

### Concurrency notes

- `multer.memoryStorage()` keeps the upload buffer in RAM (capped 10 MB). Two parallel `sharp` calls write the full PNG and the thumbnail; both `await` so the row is only inserted once both files exist.
- `enforceMaxPhotos()` runs synchronously after each upload. With `MAX_PHOTOS=10000` this is fast; if it ever grows we'd want it on a timer rather than the hot path.

### Security

- **No auth on uploads.** The kiosk app is the only thing that should hit `/upload`, but anyone on the LAN can. For the exhibition setting that's acceptable; outside that, add a shared-secret header.
- **Plain HTTP.** Browsers will accept `http://` for `localhost` and LAN IPs without HTTPS, which is what makes this whole setup possible without certificates.
- `ADMIN_KEY` is sent in plaintext over LAN HTTP. Same trust model: fine for the LAN, not for anything internet-facing.

---

## 3. Kiosk app (`kiosk-app/`)

React 19 + Vite, with all of the interesting logic in **`src/FacePaintCanvas.jsx`** (~700 lines). `KioskApp.jsx` is a screen-flow shell (home → instructions → consent → camera → success) plus a 60 s inactivity timer that resets to home.

### Vendor scripts

MediaPipe Hands and FaceMesh are loaded via `<script src="https://cdn.jsdelivr.net/npm/@mediapipe/...">` in `index.html`. **This is an internet dependency on a system that's supposed to be offline** — see §6.

### Camera

`getUserMedia` requests 1920×1080. If a device labeled `camo` is enumerated it's picked specifically (Camo virtual webcam); otherwise default. `<video>` is mirrored (`scaleX(-1)`), opacity 0.6, and `mapToScreen()` mirrors and letterboxes coords from MediaPipe's normalized space onto the canvas.

### Two MediaPipe models in one loop

```js
const loop = async () => {
  await hands.send({ image: video })
  await faceMesh.send({ image: video })
  requestAnimationFrame(loop)
}
```

Both run every frame. FaceMesh feeds `actNose`/`actTilt`, which the lock-mode (peace gesture) uses to keep the drawing pinned to the face when the head moves. Hands runs the whole gesture pipeline.

### Gesture model

The **right hand's index tip** (`lm[8]`) is the cursor. The **left hand** classifies gestures using thumb-index pinch distance, middle-tip-to-wrist distance, and per-finger fold/extend tests against the wrist. Possible actions: `hover` (default), `pinch` (draw / click / pick color), `peace` (toggle lock), `open` (erase).

Frame-counters (`peaceF`, `openF`) require N consecutive frames before promoting to a gesture — this is what kills the "single jittery frame triggered erase" failure mode. Constants:

- `pinch < 0.04` → `pinch` immediately (pinch is intentional and easy to detect).
- `peaceF.current > 5` → `peace`.
- `openF.current > 6` → `open`.

### Cursor pipeline (per frame, with the recent fixes)

```
lm[8] (normalized)
  └─ mapToScreen()                              [letterbox + mirror]
       └─ velocity gate (NEW)                   [reject MediaPipe glitches]
            └─ + velocity * PREDICT             [predict-ahead]
                 └─ OneEuroFilter (β=0.03)      [smooth tremor]
                      └─ sx, sy                 [used for cursor + drawing + hit-tests]
```

Each step is necessary:

- **`mapToScreen`** is geometry only.
- **Velocity gate** (`lastGood`, `holdCount`) freezes the cursor when a sample jumps faster than `MAX_SPEED = 6000 px/s`, for up to `MAX_HOLD = 12` frames (~200 ms) before giving up. This handles the "MediaPipe relabels pinky as index tip" case where the raw landmark teleports across the screen.
- **Prediction** (`PREDICT = 0.65`) compensates for the inherent delay of OneEuro. Since it now multiplies the *gated* velocity, a glitch can't blow it up.
- **OneEuroFilter** removes residual tremor with adaptive cutoff (more aggressive smoothing when slow, more responsive when moving fast).

### Stroke storage and rendering

- A finished stroke is `{ points: [{x,y}, ...], color, size }` pushed onto `lines.current` (a ref, not state — re-renders are not driven by drawing).
- An in-progress stroke lives in `curPts.current`; points are added if they're more than **5 px** from the previous one (sub-5px deltas are mostly camera noise).
- The render loop runs on every `onResults` frame:
  - Clears the canvas.
  - Applies a face-locked transform if `locked.current`.
  - Walks each stroke and calls `strokePath()` which renders a **smooth curve through point midpoints** using `quadraticCurveTo` (points become control handles, midpoints become anchor points). This is what removes the polygonal look from raw polylines.
  - Same for the in-progress stroke.

### Eraser

Open palm + cursor near a stroke. Two important pieces:

- **Post-pinch cooldown**: when leaving `pinch`, stamp `lastPinchEnd`. While that's recent (< 600 ms), demote `open` to `hover`. This kills the most common false-positive: user finishes a stroke, releases the pinch, and the natural finger splay before the hand drops gets misread as "open palm = erase".
- **Partial erase, not whole-line**: walks each stroke's points; any point within `ERASE_R` (30 px) is dropped, and the surviving points are split into multiple sub-strokes at the gap. Color and size are preserved on each sub-stroke. Strokes untouched in the frame are kept by reference (no GC churn).

A single `undoStack` snapshot is pushed at the start of each erase session (`wasErasing` flag), so a long swipe is undoable in one step.

### Color wheel and buttons

Drawn into a separate UI canvas (`uiCanvasRef`) with a radial HSL ring at fixed coords (`CW_X=110, CW_Y=440, CW_R=80`). Pinching while the cursor is inside the wheel reads the angle/radius and locks the resulting `hsl()` color until pinch ends.

UI buttons use `document.elementFromPoint` over the cursor coords to find the closest `.air-btn`, then dispatch via `data-action` (`capture`, `lock`, `undo`, `<size>`). A 500 ms debounce prevents double-clicks.

### Capture

`exportImage()` (exposed via `useImperativeHandle`) draws the mirrored video frame onto a temp canvas, overlays the drawing canvas, and returns a PNG `Blob` via `toBlob`. `KioskApp.jsx` then `POST`s it to `${VITE_API_BASE}/upload`.

---

## 4. Wall display (`wall-display/`)

Tiny: one component (`Wall.jsx`) renders a static-positioned grid of `<img>` elements. On mount it polls `${VITE_API_BASE}/photos` every **5 seconds**. Slot positions are randomized within a fixed-size grid; positions are remembered across renders in `positionsRef` so photos don't jump around when new ones come in.

Admin mode toggles with `Shift+D`; while on, double-clicking a photo sends `DELETE /photos/:id` with the hardcoded admin key.

---

## 5. Improvements landed so far

In rough chronological order; this is what differs from the original Render/Cloudinary version.

1. **Local-LAN backend.** Replaced the Render-hosted Cloudinary + Postgres backend with the local Express + SQLite + sharp server. No internet at runtime for the photo path.
2. **`VITE_API_BASE`.** All hardcoded `*.onrender.com` URLs in both frontends now read from `import.meta.env.VITE_API_BASE`. `.env.example` files document the expected values.
3. **Server prints LAN IPs at boot** so the operator can copy/paste into the wall-display `.env` without guessing.
4. **`HOST` env var** for the server bind address; defaults to `0.0.0.0`.
5. **History purge.** Tracked `node_modules` and conflict markers were rewritten out of the git history with `git filter-repo`.
6. **Eraser intentionality.**
   - `openF` frame-counter (>6 frames required) — mirrors the existing `peaceF` pattern. Single-frame flickers no longer erase.
   - Post-pinch cooldown (600 ms) — natural finger splay after releasing a pinch no longer triggers erase.
7. **Partial erase.** Eraser splits a stroke at the eraser radius instead of deleting the whole connected line.
8. **Smoothed rendering.** Strokes are now drawn as quadratic curves through point midpoints. Min sample distance bumped from 3 → 5 px.
9. **MediaPipe glitch suppression.** Velocity-gate (`MAX_SPEED 6000 px/s`, `MAX_HOLD 12 frames`) freezes the cursor during brief landmark mislabels.
10. **Eraser cuts whole strokes only when the cursor passes through them**, preserves color/size of surviving sub-segments, and only pushes one undo snapshot per swipe.

---

## 6. Known limitations and risks

These are the things that will bite next, roughly in priority order.

### MediaPipe is loaded from a CDN

`index.html` has hard-coded `https://cdn.jsdelivr.net/npm/@mediapipe/...` script tags. **If the kiosk has no internet at boot, those tags fail and the whole gesture pipeline is dead.** The system is "local LAN at runtime" in spirit but not yet in fact. Fix: vendor `@mediapipe/hands` and `@mediapipe/face_mesh` into `kiosk-app/public/` (or as npm deps with a webpack/vite import), and rewrite the `locateFile` callbacks to point at the local files.

### Cross-app import in `KioskApp.jsx`

```js
import Wall from "../../wall-display/src/Wall"
```

The kiosk app reaches across the project boundary into `wall-display/src/Wall.jsx`. This works under Vite but it's load-bearing crud — changes in `wall-display` can break the kiosk. Either delete the import (the kiosk doesn't need a wall route in the local-LAN topology) or extract the shared code into a third package.

### Two `Wall.jsx` files with diverging logic

`kiosk-app/src/Wall.jsx` (with SSE, paging, fade transitions, slot tuning) and `wall-display/src/Wall.jsx` (5 s polling, simpler grid) are both alive. The wall-display one is the authoritative production view; the kiosk one looks like a leftover from when both views were served by one app. Audit and delete.

### GitHub Pages config still present

`kiosk-app/package.json` still has `"homepage": "https://BayanHattari.github.io/Character-scan-TechHub"` and `vite.config.js` has `base: '/Character-scan-TechHub/'`. For local-LAN-only use, the base path is unnecessary and gives the dev server a misleading URL prefix. Drop both unless gh-pages deployment is still needed.

### Wall-display polls instead of using SSE

The wall-display refreshes every 5 s by re-fetching the entire photo list. New photos appear with up to 5 s lag, and the request is full-list every time. The server already exposes `/events`; wiring SSE into wall-display would give instant updates and remove the polling cost.

### Hardcoded `ADMIN_KEY` in client code

`wall-display/src/Wall.jsx` ships `"TechHub-Admin-2026"` in the bundle. Any kid who opens DevTools can delete photos. For an exhibition this is fine; for anything past the event, move the key out of client code (server-side admin UI gated by a session cookie).

### No upload-side rate limit / throttle

`POST /upload` will accept whatever is thrown at it. A misbehaving kiosk client (or an open-palm gesture re-firing capture in a loop) could fill the disk. Add a per-IP rate limit and/or a min-interval on `KioskApp.handleCapture`.

### Stroke point arrays grow unbounded during very long sessions

`lines.current` accumulates every stroke until the user finishes (capture or inactivity timeout). Long, dense drawings could push thousands of points and start dragging the per-frame render. In practice the inactivity timer (60 s) caps this. If we ever extend the session length, simplify finished strokes via Ramer–Douglas–Peucker before pushing to `lines.current`.

### Camera selection by label substring

`const camo = vDevs.find(d => d.label.toLowerCase().includes('camo'))` is fragile — different machines list cameras differently, and Safari/Firefox redact labels until a permission grant. If the wrong camera is picked, gesture detection fails silently. A future improvement: explicit camera-picker UI on first run, persisted in localStorage.

### Reliance on a continuous render loop, even when idle

`requestAnimationFrame` keeps `hands.send` running every frame even with no hands on screen. On low-end kiosk hardware that's expensive battery/CPU. Could downshift to e.g. 10 fps when no hands have been seen for 2 s, and ramp back up on first detection.

### Partial-erase can leave 1-point sub-segments

If the eraser cuts very close to the start of a stroke, the leading sub-segment may be 1 point and is intentionally dropped (the renderer needs ≥ 2 points to draw). Fine visually, but if the user expected a tiny dot to remain, it won't. Probably not worth fixing.

### `enforceMaxPhotos` runs on the upload hot path

Synchronous SQLite query + `unlink`s after each upload. For `MAX_PHOTOS=10000` it's negligible; if pruning a large batch it could add latency. Move to a setInterval if it ever shows up in profiles.

### No tests

Zero test coverage anywhere. Gesture code in particular is tricky — every behavior is a constant + a counter and is easy to regress. Even simple unit tests over the OneEuroFilter, the partial-erase splitter, and the velocity gate would catch a lot.

---

## 7. Suggested next improvements

A short list of "I would do this next."

1. **Vendor MediaPipe locally** so the kiosk works fully offline. Highest impact for the exhibition use case.
2. **Delete the cross-app `Wall.jsx` import** in `KioskApp.jsx` and remove `kiosk-app/src/Wall.jsx` if it's unused.
4. **Add a per-frame max-points and/or RDP simplification** to bound long-session memory.
5. **Tiny test harness** for the three pure functions: `OneEuroFilter`, the gesture-classifier (given a frame of landmarks → action), and the partial-erase splitter. Vitest, no DOM needed.
6. **Left hand or right hand draws toggle** in the UI, so people can switch if they want to draw with their dominant hand.
---

## 8. Tunables cheat-sheet

The constants you'll most likely want to revisit live in two places.

**`kiosk-app/src/FacePaintCanvas.jsx`** (top of file or inline):

| Name | Current | What it controls |
|---|---|---|
| `PREDICT` | 0.65 | How far ahead the cursor extrapolates. Lower = more lag, less overshoot. |
| `ERASE_R` | 30 | Eraser hit radius in pixels. |
| `peaceF.current > 5` | 5 frames | How long peace must be held to toggle lock. |
| `openF.current > 6` | 6 frames | How long open palm must be held before erasing starts. |
| Post-pinch cooldown | 600 ms | Window after a pinch ends in which `open` is ignored. |
| Min sample distance | 5 px | Below this, samples are dropped as noise. |
| `MAX_SPEED` | 6000 px/s | Velocity above which a sample is treated as a glitch. |
| `MAX_HOLD` | 12 frames | Max frames the gate will freeze the cursor before giving up. |
| OneEuro `β` | 0.03 | Higher = more aggressive smoothing on fast motion. |

**`server/.env`**:

| Name | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address. Don't change unless you know why. |
| `PORT` | 3000 | If you change, update both `.env`s on the kiosk and the wall-display. |
| `ADMIN_KEY` | `TechHub-Admin-2026` | Currently also hardcoded in `wall-display/src/Wall.jsx`. |
| `MAX_PHOTOS` | 10000 | Oldest beyond this are pruned (file + row). |
| `PHOTOS_DIR` | `./photos` | |
| `DB_PATH` | `./data/photos.db` | |

---

## 9. Repo conventions

- Frontend env: `VITE_API_BASE` is read directly via `import.meta.env`. There's no central config module — direct reads are fine here because there's only one variable.
- Backend env: read via `dotenv` at the top of `server.js`. All env reads are consolidated in the first ~25 lines of the file.
- No bundler tricks, no monorepo tooling, no shared package. Three independent Vite/Node projects in one repo.
- `node_modules/`, `server/photos/`, `server/data/`, and `*.db*` are gitignored.
