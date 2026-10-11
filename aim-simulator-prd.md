# PRD — Aimprint (Frontend + Telemetry)

> **Scope note for Claude Code:** This document covers **only** the browser-based aim trainer and its telemetry pipeline into Supabase. Do **not** implement ML models, Python backends, feature engineering, LLM coaching, or any inference API. Those are out of scope for this build.

---

## 1. Objective

Build a web-based 3D FPS aim trainer in Three.js that:

1. Delivers a responsive, low-latency flick-shot training loop in the browser.
2. Captures high-frequency mouse telemetry per target attempt.
3. Persists structured telemetry rows to Supabase for downstream ML use (out of scope here).
4. Supports a hidden "Bot Mode" that programmatically drives the camera to synthesize labeled non-human training data.

The trainer itself must feel legitimately usable — targets, hit feedback, and camera control should behave like a real aim trainer, not a demo.

---

## 2. Tech Stack

| Concern | Choice | Notes |
| :--- | :--- | :--- |
| Build tool | **Vite** | Fast dev server, zero-config. |
| Language | **Vanilla JavaScript** | Keep ceremony low; TypeScript is optional. |
| 3D engine | **Three.js** (latest stable) | Use ES module imports from `three`. |
| Camera control | `PointerLockControls` from `three/examples/jsm/controls/PointerLockControls.js` | Request `unadjustedMovement: true` where supported. |
| Persistence | **Supabase** (JS client, `@supabase/supabase-js`) | Anon key only, RLS-friendly inserts. |
| Hosting target | Vercel or Netlify (free tier) | Must build cleanly with `vite build`. |
| Package manager | npm | Windows-friendly; no yarn/pnpm requirement. |

**No frameworks** (no React, Vue, Svelte). Keep the DOM overlay as plain HTML/CSS.

---

> **v2 status:** the four phases in §8 shipped and are verified against §9. The project has
> since been extended into a multi-routine trainer with a home screen, configurable
> sensitivity, and a difficulty manager. Items marked **(v2)** below were out of scope for
> the original build and are now explicitly in scope.

## 3. In Scope / Out of Scope

### In scope
- Vite + Three.js project scaffolding
- Minimal 3D scene and crosshair overlay
- Pointer lock camera with raw mouse input
- Target spawning, hit detection, hit/miss feedback
- Game loop with per-attempt timing
- In-memory telemetry buffering
- Async batched inserts to Supabase
- Bot Mode with linear and smoothed sub-modes
- Basic HUD (score, accuracy, avg time to click)
- **(v2)** Home screen for choosing a training routine and changing settings
- **(v2)** Configurable sensitivity: mouse DPI plus in-game sens on the Valorant scale
  (0.07°/count), with eDPI and cm/360 shown to the player
- **(v2)** Difficulty state manager (easy / medium / hard) driving per-routine parameters
- **(v2)** Training routines. Five were designed; **three ship for the data-collection
  campaign**: precision flick, dynamic reflex (time-to-live), and reactive strafing (a single
  moving target). The two multi-concurrent-target routines — static flicking and target
  switching — are **withheld** from the menu (their code is retained) because their engaged-target
  telemetry is ambiguous; see `AUDIT-2026-10.md` #10.
- **(v2)** A single moving target (strafing) and target time-to-live (spidershot). Multiple
  concurrent targets exist in code but are withheld with the two routines above.

### Out of scope (do NOT build)
- Python backend, FastAPI, Hugging Face Spaces
- Any ML training, inference, or feature engineering
- Groq or any LLM integration
- Coaching report modal / K-Means archetyping
- User authentication, user profiles, leaderboards
- Sound effects, textures, lighting beyond flat colors

---

## 4. Suggested Project Structure

```
aim-trainer/
├─ index.html
├─ package.json
├─ vite.config.js
├─ .env.local              # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (gitignored)
├─ .env.example
├─ src/
│  ├─ main.js              # Entry: boots scene + game loop
│  ├─ scene.js             # Three.js scene, renderer, camera, environment
│  ├─ controls.js          # PointerLockControls wrapper + input state
│  ├─ target.js            # Target spawning + geometry
│  ├─ game.js              # Game loop, scoring, hit/miss handling
│  ├─ telemetry.js         # Per-attempt buffer + payload assembly
│  ├─ supabase.js          # Supabase client + insert helper
│  ├─ bot.js               # Bot Mode driver (linear + smoothed)
│  ├─ hud.js               # Score / accuracy / avg time overlay
│  └─ constants.js         # Tunable numbers (FOV, target radius, spawn range)
└─ public/
   └─ crosshair.svg        # Optional; a CSS crosshair is also fine
```

Keep modules small and single-purpose. No god-objects.

---

## 5. Functional Requirements

### 5.1 Scene & Environment
- Fixed-size renderer that resizes to the window; `devicePixelRatio` capped at 2.
- Background: solid mid-gray (`#1a1a1a` or similar). No skybox.
- A subtle wireframe or grid plane behind the target play area for depth perception. No textures.
- Include a few reference cues so depth reads correctly: a floor grid at `y = -5` and optional back wall / side wall wireframes at the far edge of the play volume. Without depth cues, players can't judge distance on the Z axis.
- Camera: `PerspectiveCamera`, FOV 90, near 0.1, far 1000. Camera starts at origin looking down `-Z`.
- No lights required if using `MeshBasicMaterial`. Prefer this — no shading cost.
- Crosshair: fixed HTML/CSS element centered on screen (not a 3D object). Small dot or plus sign.

### 5.2 Pointer Lock & Camera Input
- Show a "Click to start" overlay on load. Clicking it requests pointer lock.
- Use `PointerLockControls`. On `lock`, hide the overlay and start the game. On `unlock`, pause the game and show the overlay again.
- When requesting pointer lock, pass `{ unadjustedMovement: true }` if the browser supports it. Fall back gracefully if not.
- **Do not** apply any smoothing, easing, or acceleration to mouse input. Raw `movementX` / `movementY` → yaw/pitch, one-to-one.
- **(v2)** Sensitivity is configured on the home screen from mouse DPI and an in-game sens
  value on the Valorant scale, and persisted. `constants.js` holds only the defaults.
  The conversion lives in `sensitivity.js`; the input path stays strictly one-to-one.
- Clamp pitch to `±89°` to prevent camera flip.

### 5.3 Target Spawning (3D volume)
- Target: `SphereGeometry` with radius from `constants.js` (start at ~0.5 world units).
- Material: `MeshBasicMaterial`, bright color (e.g. `#ff5555`).
- **Spawn position is a random point in a 3D volume in front of the camera** — not a flat wall. Targets vary along all three axes so distance genuinely differs between attempts:
  - `x ∈ [-8, 8]` (left/right)
  - `y ∈ [-4, 4]` (up/down)
  - `z ∈ [-25, -8]` (near/far along the camera's forward axis; more negative = farther)
- All ranges live in `constants.js` as `SPAWN_VOLUME = { xMin, xMax, yMin, yMax, zMin, zMax }`.
- **Do not scale target size with distance.** Keep the world-space radius fixed so farther targets subtend a smaller visual angle. This is the whole point of adding Z variance — distance should genuinely affect difficulty. If you scale for constant screen size, the third axis becomes cosmetic.
- Reject any spawn that lands within a minimum radius of the camera (e.g. `distance < 5`) so a target never spawns on top of the crosshair.
- Only one target exists at a time **in the single-target flick routine**. After a click
  (hit or miss), immediately despawn the current target and spawn the next. **(v2)** Other
  routines hold several targets at once and may move them; see the routine roadmap.

### 5.4 Hit Detection
- On `mousedown` (left button) while pointer is locked: cast a ray from the camera through screen center (`(0, 0)` in NDC).
- If the ray intersects the current target → **hit**. Otherwise → **miss**.
- On a hit, compute the click offset from target center:
  - Get the intersection point in world space.
  - Convert to the target's local space, then to a 2D `(x, y)` offset relative to the plane perpendicular to the camera-to-target vector.
  - Store as `click_offset_x`, `click_offset_y` in world units.
- On a miss, `click_offset_x` and `click_offset_y` are `null`.

### 5.5 Game Loop & Timing
- Use `requestAnimationFrame` for the render loop.
- Per-attempt timer: `performance.now()` at spawn, again at click. Delta → `time_to_click_ms` (integer, rounded).
- Session lifecycle:
  - A `session_id` (UUID via `crypto.randomUUID()`) is generated on pointer-lock start and reused until unlock.
  - On unlock, freeze the session; a new lock starts a fresh `session_id`.

### 5.6 Telemetry Capture
- Attach a `mousemove` listener while the pointer is locked.
- On each event, push `{ t, dx, dy }` into an in-memory array where:
  - `t` = `performance.now() - spawnTimestamp` (integer ms).
  - `dx` = `event.movementX`.
  - `dy` = `event.movementY`.
- **Critical:** the buffer is per-attempt. Clear it when a new target spawns.
- **Do not** call Supabase from inside `mousemove`. Buffer only.
- The first entry of every buffer should be `{ t: 0, dx: 0, dy: 0 }` (spawn baseline).

### 5.7 Persistence (Supabase)
- Initialize the Supabase client from `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- On each click, assemble the payload (see §6) and fire an async insert into `telemetry_logs`.
- Insert must be **fire-and-forget from the game's perspective**: the next target spawns immediately; do not `await` the insert on the render path.
- Log insert failures to `console.warn` — never block the game loop or surface errors to the player.

### 5.8 Bot Mode (Synthetic Data Generator)
- Toggle: hidden. Enable via URL query param `?bot=linear` or `?bot=smoothed`, or a keybind (e.g. `B` to cycle).
- When active:
  - Ignore real mouse input for camera rotation (still allow `mousemove` to be logged if you want — but the bot's own rotations should drive the recorded `dx`/`dy`, not the human's hand).
  - On each target spawn, compute the yaw/pitch delta needed to aim at the target.
  - Drive the camera over N frames according to the selected sub-mode:
    - **Linear**: constant angular velocity, straight interpolation, single click at arrival. Zero jerk.
    - **Smoothed**: cubic Bezier easing (ease-in-out) toward the target. Low jerk, smooth deceleration.
  - Total flick duration randomized within a plausible range (e.g. 150–350 ms) so payloads vary. Optionally scale the upper bound with the required angular distance so far/wide targets take slightly longer to reach — this mirrors human behavior and makes synthetic data more realistic.
  - Emit synthetic `mousemove` telemetry entries matching the driven rotation, so the buffer looks structurally identical to a human's.
  - **Always** click the target center (or with a tiny synthetic offset) — bots hit.
- Every payload produced in Bot Mode must set `is_human: false`. All human payloads set `is_human: true`.

### 5.9 HUD
- Top-left overlay, plain HTML/CSS, non-interactive (`pointer-events: none`):
  - Score (hits)
  - Attempts
  - Accuracy % 
  - Average time-to-click (ms)
- Updates once per attempt. No fancy animations.

---

## 6. Data Schema

**Supabase table: `telemetry_logs`**

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary key, `default gen_random_uuid()` |
| `created_at` | `timestamptz` | `default now()` |
| `session_id` | `uuid` | Groups attempts within one pointer-lock session |
| `is_human` | `boolean` | `false` for Bot Mode payloads |
| `bot_mode` | `text` | `null`, `'linear'`, or `'smoothed'` |
| `target_distance` | `float8` | Euclidean 3D distance from camera position to target center at spawn (varies per attempt since targets spawn at different depths) |
| `time_to_click_ms` | `int4` | Rounded milliseconds |
| `click_result` | `text` | `'hit'` or `'miss'` |
| `click_offset_x` | `float8` | Nullable (null on miss) |
| `click_offset_y` | `float8` | Nullable (null on miss) |
| `trajectory` | `jsonb` | Array of `{t, dx, dy}` |

**Trajectory JSON shape:**
```json
[
  {"t": 0,  "dx": 0,   "dy": 0},
  {"t": 12, "dx": 45,  "dy": -5},
  {"t": 28, "dx": 110, "dy": -12},
  {"t": 44, "dx": 30,  "dy": -2}
]
```

Ship a `schema.sql` file at the repo root with the `CREATE TABLE` statement and permissive-insert RLS policy for the anon role, so the schema is reproducible.

---

## 7. Non-Functional Requirements

- **Performance:** Sustain 144 FPS on a modern Chrome/Edge desktop. No frame drops during rapid mousemove events. Never allocate large objects inside the render loop.
- **Latency:** Time from click to next target spawn should be visually imperceptible (< 16 ms on the render path). Supabase insert must not block this.
- **Browser support:** Latest Chrome and Edge on Windows. Firefox nice-to-have. No IE, no mobile.
- **Bundle:** `vite build` produces a static bundle deployable to Vercel/Netlify with no server code.
- **Secrets:** Supabase URL and anon key via `.env.local` only. Commit `.env.example` with placeholders. `.env.local` must be gitignored.
- **Code quality:** Modules under ~200 lines each. No dead code. No inline TODOs left unresolved.

---

## 8. Development Phases (build order)

Claude Code should ship these in order and confirm each phase renders/runs before moving on.

### Phase 1 — Scaffold
- `npm create vite@latest` (vanilla JS template).
- Install `three` and `@supabase/supabase-js`.
- Set up `index.html`, `src/main.js`, empty scene rendering a colored background.
- Add crosshair CSS element.

### Phase 2 — Camera + targets
- Wire up `PointerLockControls` with the click-to-start overlay.
- Implement `unadjustedMovement: true` request.
- Spawn a single target in front of the camera.
- Raycaster-based hit detection on left click.
- Immediate respawn on hit or miss.
- Per-attempt timer.

### Phase 3 — Telemetry + persistence
- Implement the per-attempt in-memory buffer.
- Build the payload assembler.
- Wire up the Supabase client and async insert.
- Ship `schema.sql`.
- HUD with score/accuracy/avg time.

### Phase 4 — Bot Mode
- URL/keybind toggle.
- Linear driver.
- Smoothed (Bezier) driver.
- Synthetic telemetry emission with `is_human: false`.

Stop after Phase 4. Do not scaffold Python, ML, or LLM code even as placeholders.

---

## 9. Acceptance Criteria

The build is done when all of these are true:

- [ ] `npm run dev` starts the trainer with no console errors.
- [ ] Clicking "Click to start" locks the pointer; pressing `Esc` unlocks and pauses.
- [ ] Camera responds to raw mouse input with no perceptible smoothing or lag.
- [ ] A target is always visible while the pointer is locked; hitting it immediately spawns the next.
- [ ] Targets spawn at varying depths — over 20 attempts, `target_distance` values in the DB should span a visibly wide range, not cluster around a single value.
- [ ] Left-click while aimed at the target registers a hit; left-click while aimed away registers a miss.
- [ ] HUD updates score, attempts, accuracy, and average time per attempt.
- [ ] Each attempt inserts one row into `telemetry_logs` with a non-empty `trajectory` array whose first entry is `{t: 0, dx: 0, dy: 0}`.
- [ ] `is_human` is `true` for human attempts and `false` for both bot modes.
- [ ] Loading with `?bot=linear` or `?bot=smoothed` produces bot-driven flicks and hits, and rows land with the correct `bot_mode` value.
- [ ] `vite build` completes with no errors and the built `dist/` runs correctly when served statically.
- [ ] No Python, no ML libraries, no LLM SDKs in `package.json`.

---

## 10. Notes & Constraints for the Coding Agent

- Windows is the primary dev environment. Use forward slashes in code but assume PowerShell / cmd for any scripting instructions in the README.
- Keep dependencies minimal. Only `three` and `@supabase/supabase-js` are required at runtime. Dev dependencies from the Vite template are fine.
- Write a short `README.md` covering: install, env setup, `npm run dev`, `npm run build`, how to enable Bot Mode, and the schema.sql instruction.
- Do not invent features not in this PRD (no leaderboards, no multiple weapons, no target sizes UI). If something is ambiguous, pick the simplest interpretation and note it in the README.
- Do not add analytics, error tracking, or telemetry beyond what's specified.
