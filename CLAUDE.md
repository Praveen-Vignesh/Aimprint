# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 General Agent Rules 🚨
**CRITICAL: NEVER USE GIT OR VERSION CONTROL COMMANDS.**

## Scope & plan

`aim-simulator-prd.md` is the specification. v1 (§8's four phases) shipped and is verified
against §9. The project is now in **v2**: a multi-routine trainer with a home screen,
player-configurable sensitivity, and a difficulty manager — all marked **(v2)** in the
PRD's §3. Moving targets and menus are **in** scope. Multiple *concurrent* targets exist in
code but are **withheld** for the data-collection campaign (see the routines note below and
`AUDIT-2026-10.md` #10).

The project is now at its **data-collection campaign**: a finite, one-off dataset of ~20 human
contributors and ~5 bot variants (≈150 sessions), feeding two offline models — a bot detector
and biometric identification. That finite framing drives the storage model (`STORAGE.md`) and
the pre-collection hardening recorded in **`AUDIT-2026-10.md`**. On 2026-10-18 all collected
data was wiped and `schema.sql` was rewritten as a single from-scratch DDL file (it is **not**
a migration any more — see its header) and applied clean; `sampling_version` was reset to 1 in
the same pass (`LABELING.md` STATUS).

Alongside the game, an **offline Python pipeline is planned to live in `model/`**: it will
pull telemetry back out of Supabase and train a human-vs-bot classifier. It is a separate
program, not a backend — nothing in `src/` imports it, nothing in it reaches the browser,
and it runs by hand after the fact. The PRD's "no Python backend" means the *game* has no
server; it does not forbid `model/`. **The code for it does not exist yet**; the design is
in `model/DESIGN.md`.

Still out of scope: no LLM integration, no coaching/archetyping, no leaderboards, no
sound, and no inference in the browser — the classifier will be trained and applied
offline, once it exists.

The **browser app's** runtime dependencies are **only** `three` and
`@supabase/supabase-js`. No frameworks — the home screen and overlays are plain HTML/CSS.
Adding a dependency or a framework *there* is a spec violation, not an improvement.
(The landing page does load Google Fonts over the network; see "Pages and styling".)
`model/requirements.txt` is a separate dependency set and is not bound by that rule.

## Implemented so far

**Game (`src/`) — complete for v2's current scope:**
- **Three routines ship; two are withheld (code kept).** The campaign menu is precision flick,
  dynamic reflex (spidershot), and reactive strafing — all single-target, so each routine's
  `aimTarget()` is correct by construction. Static flicking (gridshot) and target switching are
  multi-target and **withheld**: their `aimTarget()` returns an arbitrary `pool.active[0]`, which
  would write a misleading `tx/ty/tz` and `engaged_index` into an unregenerable dataset. They live
  in `RETIRED_ROUTINES` in `src/routines/index.js` — factories, files and `difficulty.js` entries
  all retained — and `ROUTINES` (which `isAvailable()` consults) holds only the three. Reviving one
  is moving its entry back into `ROUTINES`. `routineById()` still resolves both so old names render.
- Timed runs (**5/10/15 min**, default 5) with a home screen, pause/resume via pointer lock, and a
  results screen. See "Architecture" below for the full session/segment model.
- Full v2 telemetry pipeline: session + segment tables, columnar per-frame trajectories,
  a durable IndexedDB-backed outbox with retry/backoff, and DPI-independent sensitivity
  tracking.
- Real email/password + Google OAuth accounts (`src/supabase.js`) and a hard sign-in gate —
  **playing requires an account; there is no free-run allowance.** (The separate consent step
  was removed on 2026-10-18; agreement is now part of creating an account.)
- The in-browser Bot Mode has been **removed entirely** — no `?bot=`, no `bot.js`.

**Database (`schema.sql`) — the v2 shape, plus a label-integrity fix layered on top:**
- Five tables (`subjects`, `profiles`, `sessions`, `segments`, `session_metrics`) plus the
  `v_training_segments` view, RLS on every client-facing table, append-only by design.
- **`subjects.kind` is default-deny** (`'unknown'` by default, not `'human'`), with a
  provenance constraint and a three-valued label in the training view. This was a real
  bug — every signup used to enter the training set as a verified human. Documented in
  full in **`LABELING.md`**, whose STATUS block is the authority on how far it has rolled
  out.

**Not yet started:**
- `model/` holds only `DESIGN.md`, `.env.example`, `requirements.txt`, and the gitignored
  `data/` and `models/` directories. Building bot accounts and recruiting trusted human
  contributors — the data this pipeline needs — also hasn't started.

## Commands

```powershell
npm install
npm run dev        # Vite dev server on :5173
npm run build      # static bundle to dist/
npm run preview    # serve the built dist/ on :4173
```

Windows/PowerShell is the primary dev environment; use forward slashes in code.

There is no test runner and no linter — adding one would mean adding dependencies. See
"Verifying changes" below for how this codebase is actually exercised.

The offline pipeline will be a second program with its own virtualenv and entry points,
once it exists. Its planned commands are in `model/DESIGN.md`; none of them run today.

## Architecture

Plain ES modules, one factory function per file, no classes and no shared mutable state
between modules. `main.js` is the only composition point: it builds the scene, controls
and HUD, injects them into `createGame()`, wires the account panel and the sign-in gate,
and owns the `requestAnimationFrame` loop.

Two scoring shapes exist, and each routine declares which with a `kind` field.
**Destructible** routines (`kind: 'destructible'` — flick, gridshot, spidershot, switching)
consume the target on a hit and spawn a replacement. **Tracking** routines
(`kind: 'tracking'` — strafing, the only one) deliberately do *not* — `resolveHit` is empty,
because the drill is staying on the target, and consuming it would turn it into a flick
drill. `game.js` branches on `kind` for both scoring and telemetry (see the segment model
below).

**A timed run is the session boundary; pointer lock only pauses it.** The player picks
5, 10 or 15 minutes on the home screen (`SESSION_DURATIONS_MIN`, default 5) and
`sessions.planned_duration_ms` records that choice. `main.js` holds a three-state machine
(`idle | running | paused`) because the `lock`/`unlock` events alone can no longer say
whether a lock starts a run or resumes one: lock either calls `game.start()` (new session
row, HUD reset, first spawn) or `game.resume()` (same session, same `segment_index`
sequence); unlock calls `game.pause()`, which freezes the clock. The run ends when the
timer expires (`onExpire` → `finishRun()`) or the player picks "End run", and only then
does a results screen appear. `game.stop()` no longer exists — it is
`pause()`/`resume()`/`end()`.

**Everything downstream of `game.update()` runs on the play clock** (`now - pausedTotalMs`),
never on raw `performance.now()`. This is a correctness requirement, not telemetry hygiene:
each routine holds its own deadline in the timestamps it was handed (`spidershot.js`'s
`expiresAt`, `strafing.js`'s `nextChangeAt`), so a raw clock after a 40-second pause expires
the target on the first resumed frame and writes a fabricated `timeout` row. One subtraction
in `game.js` means no routine needs to know pausing exists.

**A run reaching `SESSION_COMPLETE_FRACTION` (70%) of its planned duration counts as
completed** — but the client cannot record that. There is no update policy on `sessions`, so
the client stamps *intent* (`planned_duration_ms`) at insert and the verdict is **derived
offline** from segment timing (`max(started_at_ms + duration_ms)` vs `planned_duration_ms`).
The results screen shows a live figure as *progress*,
never as a saved record, and persists it nowhere: the offline number is computed from
delivered segments and legitimately differs (a segment still sitting in the outbox is not
yet a delivered row).

**One row is one *segment*, not one mesh — the unified telemetry shape.** A segment is a
span of play that closes with an `outcome`: destructible routines close on a click
(`hit`/`miss`) or a timeout (`timeout`); tracking routines have no click, so they close every
`TRACK_WINDOW_MS` (`track`), and once more when the run is paused or ends. This is what
makes one table fit every mode — every row carries `routine`, `difficulty`, `outcome`, the
board layout at segment start (`targets` + `target_count`), and a per-frame stream.
`beginAttempt()` opens a segment: stamps the clock, resets dwell, snapshots the board, and
records `engaged_index` (`routine.targets.indexOf(aimTarget())`). `flushSegment(outcome,
fields)` ships the one that closed — read its `frames`/`board` **before** `beginAttempt()`
swaps in fresh arrays, so an in-flight insert keeps its own array (the buffer is replaced,
never emptied in place). An empty segment (no frame sampled yet) is never shipped — note
`flushSegment()` early-returns in that case without closing `segmentOpen`, which is
harmless because there is nothing to double-ship.

**A frame is sampled once per rendered frame, not per mousemove: `{t, dx, dy, yaw, pitch,
tx, ty, tz, on}`.** `update()` calls `sampleFrame()` every frame *after* `routine.update()`
has moved the targets, so the aim and the world state are recorded together — the fix for
tracking and moving-target modes, where the target moves even when the mouse is still.
`dx`/`dy` are the raw device counts for that frame (accumulated from the pointer stream into
`pendingDx/Dy` and drained here). `yaw`/`pitch` are the camera's absolute angles read off
`camera.quaternion` as a `YXZ` Euler (`.y` yaw, `.x` pitch) — DPI-independent. `tx/ty/tz` are
the engaged (`aimTarget()`) target's world position that frame; `on` is whether the crosshair
sat on any live target (`raycastCenter()`), which also stamps `dwellStart` on first contact.
`tx/ty/tz` are written only when the routine declares `movesTargets` (`strafing`, and the
withheld `switching`); a static-target routine omits those three columns because the position
is constant and already in the `targets` snapshot. Angles are rounded to 5 decimals, positions to 3, in
`telemetry.js`; `input_events` keep sub-millisecond `t`, because at a 1000 Hz poll rate
whole-ms rounding would collapse distinct samples.

**`dwell_ms`, `time_to_click_ms`, and `click_offset` are click-only.** They are non-null on
`hit`/`miss` rows; `null` on `timeout` and `track` rows, which have no landed shot. `dwell_ms`
is `now - dwellStart` (the crosshair first settling on a target until the click), or `null`
when it never registered (a pure miss, or a click before the crosshair touched a target).

A target that expires on its own (spidershot) still writes a row: `flushSegment('timeout')`
ships the failed attempt's search trajectory as a labeled miss before re-arming, and it
counts against accuracy but not against the average click time (the `clicks` HUD counter).

**Routines own their targets; `game.js` owns everything else.** Each routine exposes the
same shape: a live `targets` array to raycast against, `start`/`update`/`stop`,
`resolveHit`/`resolveMiss`, and `aimTarget()` (the engaged target each telemetry frame
records; routines whose target moves also set `movesTargets`). `update()` returns
`{expired}` using frozen module-level constants, since it runs every frame. A routine is
built fresh per session, so mode and difficulty changes always take effect on the next
start — which means `stop()` must dispose its pool or meshes accumulate in the scene.
Targets are pooled (`createTargetPool` in `target.js`): allocating geometry mid-session
would stutter the frame.

**Only `strafing` and `switching` actually move a target**, and they are the two that share
`routines/motion.js`: `frameDelta()` caps a single frame's elapsed time at 50ms so a
backgrounded tab does not teleport a target on return, and `clampInside`/`bounce` implement
the inset-spawn and wall-reflection invariants below. **`spidershot` does not import
`motion.js` and does not move** — it is a single *static* target on a TTL, and its
difficulty is the deadline, not the speed.

**Synthetic reference data is produced only under a subject provisioned server-side as
`kind='synthetic'`**, never by a client-controlled flag — Bot Mode was removed for exactly
this reason. `game.update()` samples the human's aim each frame; without a running session
it returns immediately.

**The home screen is the resting state.** `main.js` runs four screens — HOME, PLAYING,
PAUSED, RESULTS. Start requests the lock, `Esc` unlocks into PAUSED (clock frozen, Resume
continues the *same* run, "End run" finishes it), and a finished run lands on RESULTS.
`settings.js` owns `{dpi, sens, difficulty, routine, duration}` — `duration` in **minutes**,
converted once in `main.js`'s lock handler — persists to localStorage, sanitises everything
it reads back, and notifies subscribers; `src/ui/home.js` is the only module touching that
DOM.

`constants.js` holds defaults and every tunable (FOV, spawn volume, flick timing). Numbers
belong there or in `difficulty.js`, not inline.

### Pages and styling

**The build is multi-page, not routed, and the two visible pages do not share a
stylesheet.** `vite.config.js` declares three entries, split by payload rather than taste:

| Page | URL | Entry module | Ships | Styling |
|---|---|---|---|---|
| `index.html` | `/` | `src/landing.js` | Supabase only, ~58 kB gz | **Inline, self-contained** |
| `play.html` | `/play` | `src/main.js` | Three + Supabase, ~196 kB gz | `src/style.css` |
| `privacy.html` | `/privacy` | none — **no JS at all** | nothing | Inline, self-contained |

`/` is the SEO target and the page a stranger lands on, so it must never pull in Three;
verified after every build by checking `dist/index.html`'s script tags. Supabase is a
shared chunk both JS pages load. There is still no router and none is wanted.

**Watch the Vite entry names — they are inverted relative to the source files.**
`rollupOptions.input.main` is `index.html`, which loads `src/landing.js`; `input.play` is
`play.html`, which loads `src/main.js`. So `dist/assets/main-*.js` is the small **landing**
bundle and `play-*.js` is the game. Reading build output without knowing this is misleading.

**`index.html` is a ~1,000-line self-contained page with its own design system.** It does
**not** import `src/style.css`. It carries its own `:root` token layer — `--range`,
`--range-lift`, `--line`, `--line-soft`, `--chalk`, `--chalk-dim`, `--chalk-faint`,
`--target`, `--font`, `--wide` — in a large inline `<style>`, loads **Archivo / Archivo
Expanded from Google Fonts**, and runs a large inline `<script>` with two pieces of
behaviour: a canvas "range" animation whose RAF loop is started and stopped by an
`IntersectionObserver` (a landing page has no business burning a core off-screen), and a
custom crosshair cursor whose transform is written **once per frame** from the last known
pointer position, never inside the `pointermove` handler.

So there are **two palettes with non-overlapping names**: `--color-*` / `--space-*` on
`/play`, `--chalk` / `--range` / `--target` on `/`. Reaching for `--color-accent` on the
landing page gets you nothing. The one point of contact is deliberate: `--target` there and
`--color-accent` in `style.css` are both `TARGET_COLOR` from `constants.js`.

**Sign-in lives only on `/`.** `src/landing.js` drives a `<dialog id="auth-modal">` through
a `[data-modal="open|close"]` convention, toggling a `modal-open` class on `<body>` so the
native cursor returns while the dialog is up. It closes on the dialog's own `close` event as
well as the buttons, so `Esc` and a backdrop click restore the crosshair too. **`play.html`
has no sign-in form on purpose** — it is past the gate, you arrive already signed in. A
signed-out visitor gets a notice linking back to `/` and a disabled Start.
A third copy of the form would mean three things to keep in sync for a page nobody signs in
on.

**`style.css` opens with a `:root` token layer, and nothing below it may use a raw
colour** — this governs `/play`. Before it existed the palette was repeated by hand
(`#ff5555` six times, `#333333` seven, `#8c8c8c` five), so a brand change was a
find-and-replace that could silently miss one. Tokens cover surfaces, borders, text,
accent, shot feedback, the font stack and a six-step spacing scale.

**`main.js` publishes `BACKGROUND_COLOR` and `TARGET_COLOR` into that layer at boot**
(`publishColorTokens()`), overwriting `--color-bg` and `--color-accent`. Those two colours
exist in both worlds — Three needs numbers, CSS needs strings — and must agree or the panel
background disagrees with the scene behind it. `constants.js` is therefore the single
source; the literals in `:root` are only a pre-JS fallback. **Do not "simplify" this by
deleting either side.**

**Any rule giving an account-panel block its own `display` must pair with a `.x.hidden`
override.** `.hidden` is a bare class, so a competing `display` out-cascades it on source
order and the element becomes impossible to hide. `.screen.hidden` and `.account-row.hidden`
both exist for exactly this reason — `.account-row` is the collapsed signed-in row, which
needs `display: flex`.

`privacy.html` cannot import `style.css`, because `body { overflow: hidden }` there exists
for the game and would make a text page unscrollable. It styles itself inline and ships no
JS at all.

### Hosting, URLs and static files

**`vercel.json` sets `cleanUrls: true` and `trailingSlash: false`,** which is what serves
`dist/play.html` at `/play` and 301s `/play.html` to it. `trailingSlash` is not optional
cosmetics: `/play/` would otherwise resolve relative asset paths one directory too deep.

**`base` is `'/'`, not `'./'`, and must stay absolute.** Relative asset paths and clean
URLs are incompatible: at `/play/` a `./assets/x.js` resolves to `/play/assets/x.js` and
404s. The old rationale for `'./'` — "dist/ runs from any host or subpath" — no longer
applies, since the site is permanently at the root of `aimprint.vercel.app`. The only thing
this cost is opening `dist/index.html` over `file://`, which was never supported anyway.

**Open Graph URLs must stay absolute too**, for a different reason: crawlers do not resolve
relative `og:image`/`og:url`. Each page carries its own `canonical` and `og:url`, and each
must name the **clean** URL (`/privacy`, not `/privacy.html`) or it points at a 301 and
disagrees with `sitemap.xml`. If the hostname ever changes again, those tags and
`robots.txt`/`sitemap.xml` are the places that do **not** update themselves.

`public/` holds `favicon.svg`, `robots.txt` and `sitemap.xml`, copied verbatim to `dist/`.
`og-image.html` sits at the repo root and is **deliberately excluded** from
`rollupOptions.input` — it is a 1200×630 template used to regenerate `public/og-image.png`
by screenshot, not a shipped page.

`design/` holds `landing-d-readout.html` and `landing-gaming.html`: **design prototypes,
not build inputs.** They say so in their own headers, are absent from `rollupOptions.input`
and from `dist/`, and are reachable only via `npm run dev` at `/design/*.html`. Nothing
imports them and they may be deleted freely.

### The other markdown in this repo

All of it is current; read it rather than re-deriving:

- **`README.md`** — setup, Supabase provisioning, and the player-facing description.
- **`LABELING.md`** — why `subjects.kind` is default-deny, the migration runbook, the
  verification queries, and the STATUS block that says how far it has rolled out.
- **`SEGMENT_DELIVERY_INCIDENT.md`** — the postmortem for segments never reaching Supabase
  (403 / RLS, the `42501` upsert-header trap). It is the origin story for the outbox rules
  in "Supabase" below; read it before changing delivery.
- **`aim-simulator-prd.md`** — the spec. §3 carries the `(v2)` markers.
- **`model/DESIGN.md`** — the unbuilt pipeline's design, including the archive job and the
  bot-detector / biometric-identification training protocols.
- **`AUDIT-2026-10.md`** — the pre-collection hardening audit: every problem found before data
  collection, its fix, and the files changed (plus accepted risks and known-remaining items).
- **`STORAGE.md`** — the storage model: the `sampling_version` 4 shrink and the Free-tier
  archive-then-prune design with its operating rules.
- **`queries/campaign.sql`** — read-only operator queries for the campaign (per-subject progress,
  database size against the archive trigger, ingest-health checks).

Prefer `src/telemetry.js` + `schema.sql` over any prose if they ever disagree.

## Invariants that break silently if violated

- **`camera.updateMatrixWorld()` before every raycast.** Three only recomposes that matrix
  during `render()`, so without it a click is judged against the previous frame's aim.
  This was a real bug (commit `3c8c1c2`). `raycastCenter()` in `game.js` is the only
  raycast site in `src/`; keep it that way.
- **The telemetry buffer is replaced, never emptied in place.** `beginAttempt()` assigns a
  new array because the previous attempt's array is still travelling to Supabase; clearing
  it with `length = 0` would ship an empty `trajectory`.
- **Target radius must never scale with distance.** Depth variance in `SPAWN_VOLUME` is the
  whole point — constant screen size would make the Z axis cosmetic (PRD §5.3).
- **Sensitivity is one value; `main.js` must push a settings change into `applySensitivity`.**
  `sensitivity.js` converts DPI + in-game sens (Valorant scale, 0.07°/count) into
  `controls.pointerSpeed`, and stores `cm_per_360` on the session row as the DPI-independent
  ground truth. The `0.002` in `sensitivity.js` mirrors a PointerLockControls internal.
- **Target radius is changed by rebuilding geometry, never by scaling the mesh.** A non-unit
  scale would distort `worldToLocal` and corrupt every recorded click offset (`target.js`).
- **Never call Supabase from the pointer stream.** `onPointerMove` buffers into
  `pendingDx/Dy` and the segment's `input_events` only; the network is touched by the outbox,
  never inline.
- **Moving targets must `updateMatrixWorld()` after they move.** The routine runs before
  `renderer.render()`, and the click raycast reads `matrixWorld`, not `position`. Skip it
  and shots are judged against where the target was a frame ago.
- **Spawn inside the inset bounds before moving.** Targets spawn anywhere in
  `SPAWN_VOLUME`, but a moving one lives in that volume inset by its radius, so
  `clampInside` must run at launch or the first `bounce()` snaps it inward by up to a
  radius in one frame. This was a real bug, caught as a speed spike of 12.34 against a
  configured 5.
- **Only pass live targets to the raycaster.** Three does not skip invisible meshes, so a
  released target still in `scene.children` would register hits if it reached the ray. The
  pool keeps `active` to exactly what is on screen.
- **Bump `SAMPLING_VERSION` whenever `sampleFrame()`'s shape _or clock meaning_ changes.**
  It is stamped on every `sessions` row and is the only thing that stops a training pull
  silently mixing rows produced by two different samplers. `APP_VERSION` comes free from
  `package.json` via `vite.config.js`; `SAMPLING_VERSION` is hand-maintained in
  `constants.js`, so it is the one that gets forgotten. It is **1**: it was reset from 4 on
  2026-10-18 when all collected data was deleted, so there is no version history to carry and
  every row in the database is v1 by construction. v1 is: the frame clock excludes paused time
  (`t`/`started_at_ms` are active-play ms); `input_events` delta-encoded as `{t0, dt, dx, dy}`
  in integer tenths of a millisecond; and per-frame `tx/ty/tz` omitted for static-target routines
  (flick, spidershot), where the engaged target is stationary and its position already lives in
  the `targets` snapshot. The rule still stands for any future change — bump it and filter on it
  in a pull — but there is no older shape to exclude today. Decoding lives only in the offline archive job (`STORAGE.md`, `model/DESIGN.md`).
- **A click in a tracking routine writes no row.** `trackingShot()` flashes the crosshair
  and moves the HUD's `hits`/`attempts`, but does not close a segment, does not touch
  `clicks`, and does not call `flushSegment` — tracking segments close only on the
  `TRACK_WINDOW_MS` boundary, on `pause()` and on `end()`. Routing a tracking click through
  `shoot()` would fabricate `time_to_click_ms` on a drill that has no reaction event.
- **Never reset `segmentIndex` outside `start()`.** Resetting it on resume makes the
  post-pause rows collide with the pre-pause ones, and a collision is indistinguishable
  from a redelivery: the outbox reads `23505` on `unique (session_id, segment_index)` as
  "this row already landed" and settles it. So the entire second half of every paused
  session is discarded with no error, no warning and no retry. The loudest failure in the
  codebase is the one that prints nothing.
- **Only `beginAttempt()` may reopen a segment buffer; `flushSegment()` does not clear it.**
  `segmentOpen` is what stops `pause()` and `end()` shipping the same frames twice under two
  `segment_index` values — legal rows that no constraint catches. A destructible attempt
  interrupted by a pause is **discarded**, never flushed: there is no honest `outcome` for
  it, and `timeout` would fabricate a failure (and make `timeout` reachable for `flick`,
  where it cannot occur).
- **`SESSION_COMPLETE_FRACTION` is mirrored by the offline derivation.** Change one without
  the other and the number the player sees disagrees with the number the pipeline records.
  The client's verdict is display-only and must never be persisted.
- **The play gate is duplicated on purpose and the two halves must agree.** `canPlay()`
  (`main.js`) guards the click path; `applyStartGate()` (`home.js`) disables the button.
  Neither may grow a condition alone — a gate that passes in one and fails in the other is
  either an unreachable button or a bypass. They are not collapsed into one because
  `home.js` deliberately does not import `supabase.js`; auth reaches it only as injected
  callbacks and rendered state.
- **`ui/auth-panel.js` resolves its controls by `data-auth`, scoped to the root it is
  given — never by global id.** That is what lets the landing pages style the form however
  they like while sharing one implementation, and what stops two panels colliding. The
  names are listed in `REQUIRED` at the top of that file and must match the markup; a
  missing one throws **at construction**, naming it, rather than failing on first click.
  It also sets block visibility with an **inline `display`**, deliberately, because it runs
  on pages whose CSS it does not control and a class-based toggle loses to any rule giving
  a block its own `display` (the `.x.hidden` trap above).
- **`subjects.kind` is default-deny; never write a model prediction back into it.** See
  "Label integrity" below. A retrain that consumes its predecessor's guesses as ground truth
  amplifies its own errors, silently, across every future retrain.
- **Client-written columns are confined by a column-level `grant insert`, not just by RLS.**
  `schema.sql` revokes table-level insert on `sessions`/`segments` and grants only the specific
  columns the client legitimately writes (RLS gates rows, never columns). **A new client-written
  column must be added to BOTH the payload (`telemetry.js`) and the grant.** Send a column that
  is not granted and the whole insert fails with `42501`, which `outbox.js` classifies as
  permanent and **drops every row** — silent total loss. This is why `poll_hz` and `started_at`
  (service-written) are absent from the payload, and why `segments` excludes `id`/`created_at`.
- **One subject row is one identity — there is no duplicate-merging mechanism.** `merged_into`,
  its self-reference CHECK, the `enforce_merge_depth` trigger and `subjects_merged_into_idx` were
  all **removed**. If the same person turns up on two accounts, **exclude the extra account** at
  labelling/fetch time; do not reintroduce a merge column, and do not add a `coalesce()` collapse
  to the training view. This is safe because the cohort is ~25 hand-recruited contributors
  labelled by email, so a duplicate surfaces while labelling — **not** because the sign-in gate
  prevents duplicates (it does not; one person can hold two emails).
- **`movesTargets` is load-bearing and must not be removed as "unused".** It decides whether a
  segment's `trajectory` carries per-frame `tx/ty/tz`. `strafing` is a shipping routine with a
  genuinely moving target and sets it; stripping it would silently destroy that routine's
  tracking-error signal. It is easy to confuse with the removed `board_trajectory` /
  `tracksBoardTrajectory` (the *non-engaged* targets' paths, which only the withheld `switching`
  ever wrote) — those are gone, `movesTargets` stays.
- **A run under `SESSION_MIN_PLAY_MS` (60 s) writes nothing, and the session row and its segments
  must be withheld together.** `game.start()` builds the session payload and buffers it in
  `pendingSession`; segments buffer in `pendingSegments`. `releaseSession()` (called from
  `update()` once `elapsed` crosses the threshold) enqueues the session then replays the buffered
  segments; `end()` before that point discards both and returns `saved: false`. Releasing
  segments while holding the session back would be worse than no gate — a segment carries the
  client-minted `session_id`, so it would hit the DB with no session to reference and retry
  `23503` forever (the outbox treats a missing session as transient on purpose). The results
  screen must surface `saved: false`, or a discarded run looks saved — the exact silent loss this
  codebase is built to avoid.
- **The client never updates a session row. `poll_hz` is service-written offline; `ended_at`
  does not exist.** Both were briefly client-written at run end through a single-shot
  `sessions close own` UPDATE policy; that policy and the `ended_at` column were removed on
  2026-10-18 (see below), restoring strictly append-only. `poll_hz` (the median pointer
  inter-arrival) is derived with the service key by `queries/campaign.sql` §5 and the archive
  job, which already decodes every segment — so it is null during collection and filled before
  training. It stays out of the INSERT grant and the session payload (`poll_hz is null` is
  checked at insert); sending it at insert is a `42501` that drops the whole row. **`ended_at`
  was dropped because nothing consumes it** — the completion verdict and every duration come from
  segment timing (`started_at_ms + duration_ms`) and `started_at`; its only unique part
  (wall-clock span including pauses) is not a feature and the pause structure was never recorded.

## Supabase

**The client and the (future) pipeline both speak the v2 schema.** The earlier v1 flat
`telemetry_logs` path has been migrated and its table dropped outright:

- `src/supabase.js` requires a **real email + password account** (anonymous sign-in was
  removed), or Google OAuth. `ensureAuth()` resolves the caller's `subject_id` from
  `profiles` only when a session exists, and returns `null` otherwise — so an
  unauthenticated session writes nothing at all, which is the guarantee that no
  anonymous rows reach the table. The session **id is minted on the client** (`game.js`), so
  `insertSession` and `insertSegment` both hand rows to **durable, IndexedDB-backed outboxes**
  (one per table) rather than awaiting an id — a failed session insert no longer discards the
  run. `is_human` is gone from the client — the label is `subjects.kind`, set server-side, and it
  is **default-deny**: a new signup is `'unknown'`, never `'human'`.
- **A persisted session is not proof the account still exists.** `supabase-js` restores it
  from `localStorage` and fires `INITIAL_SESSION` with no server round-trip, so a deleted or
  revoked account still renders as signed in while silently writing nothing (`ensureAuth()`
  can resolve no `profiles` row for it). `validateSession()`, awaited at boot in `main.js`
  **before** `initTelemetryOutbox()` runs (chained with `.finally`), and also called from
  `landing.js`, forces that round-trip with `auth.getUser()` and signs out locally
  (`{ scope: 'local' }`) only on a
  definitive `401`/`403` — a network failure or a `5xx` must never be treated the same way,
  on the identical permanent-vs-transient reasoning the outbox applies to delivery failures
  below.
- **Delivery goes through `src/outbox.js`** — **two outbox instances, one per table** (sessions
  and segments), each with its own IndexedDB object store in the one `aim-trainer-outbox` database
  (version 2; the store name is load-bearing — renaming it orphans queued telemetry). Batched,
  retried with backoff, mirrored to **IndexedDB** (async — never localStorage, whose sync write
  would hitch the render loop). Delivery is a **plain INSERT, never an upsert** — PostgREST enters
  its upsert path on the `Prefer: resolution=...` header alone (the `on_conflict` query param is
  inert without it), and that path is refused with `42501` on `segments`, which grants neither
  SELECT nor UPDATE by design. Idempotency comes from the unique key instead (segments:
  `(session_id, segment_index)`; sessions: `id`): a re-sent row raises `23505`, settled as
  "already delivered". Failures are classified by SQLSTATE — classes `22`/`23`/`42` are permanent
  and get isolated row-by-row so only genuinely bad rows drop — **except `23503`
  (`foreign_key_violation`), which is transient**: a segment can reach the DB before its session
  row (separate outboxes), and that is a wait, not a failure. Each queued row also carries its
  **owner `user_id`** in the IndexedDB envelope; a row whose owner is not the signed-in account is
  **held, not attempted** (so a shared machine never ships one participant's rows under another's
  login and drops them on RLS). `initTelemetryOutbox` replays **sessions before segments**.
  `flushTelemetryKeepalive()` sends a **bounded** last batch on `pagehide` (≤~60 kB — the browser
  caps keepalive bodies at ~64 kB, and two segments already exceed that, so it fills one request
  oldest-first and the rest replay next load). **`SEGMENT_DELIVERY_INCIDENT.md` is the full
  postmortem — read it before touching this.**
- `src/telemetry.js` builds two payloads (`buildSessionPayload`, `buildSegmentPayload`)
  and stores streams **columnar** (parallel arrays keyed by field name): `trajectory`
  (per rendered frame; `tx/ty/tz` omitted for static-target routines — `sampling_version` 4),
  and `input_events` (**delta-encoded `{t0, dt, dx, dy}`** in tenths of a millisecond, one entry
  per raw pointer sample). Each segment also carries `duration_ms` (lifted from the
  trajectory tail). `buildSessionPayload` must **not** emit `poll_hz` (service-written, not in the
  insert grant — see the column-grant invariant above).
- `src/game.js` mints the session id in `start()` (`newSessionId()` → `crypto.randomUUID` with a
  fallback) and holds it in `currentSessionId`; each `flushSegment` assembles its row and calls
  `insertSegment(currentSessionId, …)` **synchronously** (no promise to await), so the network
  never blocks the loop and a segment is durable the instant it closes. It stamps `segment_index`,
  `started_at_ms`
  (`attemptStart − sessionStartMs`, on the play clock, so paused time is excluded), and
  `engaged_index` — captured at segment start as
  `routine.targets.indexOf(aimTarget())`, no longer hardcoded to 0. `onPointerMove`
  (not `mousemove`) drains `getCoalescedEvents()` into both the per-frame trajectory and
  the segment's raw `input_events` buffer.
- `src/main.js` gathers the session hardware block (dpi/sens/`cm360`, `CAMERA_FOV`, a
  rolling `refresh_hz` estimate off the render loop, coarse device fingerprint, plus
  `app_version`/`sampling_version`) and passes it to `game.start({ session })` alongside
  `plannedDurationMs`. It also owns the account panel wiring and the sign-in gate below.
- **There is no consent system (removed 2026-10-18), and the gate is a signed-in account and
  nothing else.** `canPlay()` in `main.js` is `signed_in`; `applyStartGate()` in `home.js`
  mirrors it, and the two must stay in step. What was removed, in full: `profiles.consent_version`
  / `consented_at` and the matching `subjects` pair; `CONSENT_VERSION`; `recordConsent()` /
  `refreshConsent()`; the `consented` field on the auth state; `current_consent_version()` and the
  `consent` clause it fed in the `sessions` insert policy; the `mirror_consent_to_subject()`
  trigger; and the consent checkbox block with its six `data-auth` hooks. **The `profiles update
  own` policy went with it** — consent was its only purpose — so `profiles` is now read-only to
  the client (`revoke update`, no grant after it). Agreement is now a line of copy on the sign-up
  card: creating an account is the agreement. `privacy.html` explains it and is linked from there.
- **Playing requires an account; there is no trial.** A `FREE_SESSION_LIMIT` trial used to
  precede the gate and was removed: it wrote nothing (no auth session, no subject to attach
  to), so every run it granted was play the project could not learn from — roughly twenty
  minutes discarded per recruited participant. Since the telemetry is the deliverable,
  capturing the first session beats the conversion a try-before-signup hook buys. The
  underlying guarantee is unchanged and still enforced server-side: **no auth session, no
  write.**
- The pipeline's fetch stage (**not yet written**) is meant to select from the
  **`v_training_segments`** view with the service key. The view emits `subject_id` (one subject
  row is one identity — there is no merge/collapse step) plus `duration_ms`, and runs
  `security_invoker`. **`is_human` is three-valued** — `true`/`false`/`NULL`, where `NULL`
  is an unlabelled subject (the default state of every public signup) and must be excluded
  with `where is_human is not null`, never coerced or imputed. The view also emits
  `subject_kind_source`, `subject_cohort` and `subject_labeled_at`. See `model/DESIGN.md`.

**This requires the Email provider enabled in the Supabase dashboard, with "Confirm email"
ON** (Authentication → Providers → Email). Rationale: a verified address is how a
participant gets invited back for session 2, and sessions-per-subject across separate days
is the binding constraint on the biometric model, so it is worth more than signup
conversion. Two consequences, both fine and neither losing data:

- A new signup has **no session** until the emailed link is clicked, so `signUp()` returns
  `needsConfirmation: true`.
- The player cannot start a run until confirmed. Combined with there being no free-run
  trial, **every run belongs to an authenticated subject** — there is no unauthenticated run
  to lose. (A run under `SESSION_MIN_PLAY_MS` is deliberately discarded, which is a different
  thing: it is dropped on purpose, visibly, not lost.)

Custom SMTP is live on `smtp.gmail.com:587` with a Gmail App Password. The built-in
Supabase mailer is capped at **2 emails/hour** and is not usable for real signups; custom
SMTP raises that to 30/hour by default (Authentication → Rate Limits). With no
credentials or no signed-in account the game still runs and simply drops rows.
`sessions.poll_hz` is written offline with the service key (`queries/campaign.sql` §5 / the
archive job); the client never writes it, and `ended_at` was dropped (see the invariant above).

**The v1 flat table has been dropped outright**, not merely renamed-and-ignored.
`schema.sql` no longer renames or revokes on it, and **neither statement may be
reinstated**: `REVOKE` has no `IF EXISTS` form, so revoking on a table that no longer
exists fails with `42P01` and, because the whole file runs as one implicit transaction,
rolls back the entire run.

**The v2 shape (what `schema.sql` defines).** Six tables, split because hardware and
settings are session-scoped while outcomes are segment-scoped:

- `subjects` — the pseudonymous person, deliberately *not* `auth.users`. Deleting an
  account drops the `profiles` row and so anonymises the telemetry rather than destroying
  it.
- `profiles` — the `auth.users` ↔ subject link. Created by an `on_auth_user_created`
  trigger, never by the client, so nobody can attach themselves to another subject.
- `sessions` — one timed run: routine, difficulty, resolved `routine_config`,
  `planned_duration_ms`, and the hardware block (`dpi`, `sens`, `cm_per_360`, `refresh_hz`,
  `poll_hz`). Those last are not optional metadata: `dx`/`dy` are raw device counts, so a
  cross-user model without them learns the hardware.
- `segments` — one span of play, the same unit `game.js` already flushes. Adds
  `input_events` (raw pointer samples from `getCoalescedEvents`, sub-frame timing)
  alongside `trajectory` (per-frame, carries world state). They are not interchangeable.
- `session_metrics` — derived aggregates, written offline with the service key, read by
  the player.
- `archive_manifest` — the index of the offline Parquet archive (one row per archived
  session, with the checksum that gated its prune). Service-key only, RLS-on-no-policy.

Rules the v2 design encodes, worth preserving in any migration:

- **`subjects.kind` is the authoritative human/synthetic label, not a per-row boolean —
  and it is default-deny.** A new signup is `kind='unknown'`; it used to default to
  `'human'`, which silently enrolled every stranger into the training set as a verified
  human. `'human'` and `'synthetic'` are set only by a deliberate service-key write, and
  `subjects_label_has_provenance` forces `kind_source` to move with them, so a label can
  never exist without its provenance. Synthetic reference data is produced by driving a bot
  in a real browser under a subject provisioned server-side as `kind='synthetic'`
  (`kind_source='provisioned'`), never by trusting a client flag. (`sessions.bot_mode`, the
  legacy per-session flag, has been **dropped** — do not reintroduce a client-controlled bot
  field; that is exactly what the subject-level label replaced.) **Model predictions must never
  be written back into `kind`** —
  ground truth is what a person decided; a retrain that consumes its predecessor's guesses
  amplifies its own errors.
- **Strictly append-only: NO update policy and NO delete policy on any table.** A behavioural
  reference set the account holder can rewrite is not a reference set, so `subjects`, `sessions`,
  `segments`, `session_metrics` and `profiles` all have `revoke update` and no update grant — the
  client can only insert and (where a select policy exists) read. Every service-written value
  (`poll_hz`, the labels, `session_metrics`) is written with the service key, which bypasses RLS.
  There was briefly one exception — a single-shot `sessions close own` for `ended_at`/`poll_hz` —
  removed on 2026-10-18 with the `ended_at` column. **Do not reintroduce an update policy on any
  table.** (`subjects` carries no policy at all; there are five policies in the file.)
- **`segments` has no `select` policy at all.** Trajectories are the raw material of a
  biometric template, so an account cannot download its own reference data to replay it.
  Aggregates reach the player through `session_metrics`, and the training pull goes
  through the `v_training_segments` view with the service key.
- **Every policy calls `(select public.current_subject_id())`, never the bare function.**
  `STABLE` promises the value will not change within a statement; it does **not** make
  Postgres evaluate it once. A bare call inside a per-row subplan re-runs for every row —
  and twice per row in the `segments` insert policy, whose `EXISTS` reads `sessions` and so
  re-applies that table's own RLS. The scalar-subquery form becomes an InitPlan evaluated
  once per statement. Keep the wrapper; the comment above the function explains it.
- **`segments` carries no index on `outcome`, deliberately.** It was dropped: four distinct
  values on the largest table means the planner never picks it, nothing queries it (there
  is no select policy, and the training pull filters on routine and label), and on an
  append-only table it concentrated every insert onto four hot leaf pages shared by all
  concurrent writers. The two payload columns (`trajectory`, `input_events`) are also set to
  `lz4` compression — a throughput change, not a disk one, since every one of those blobs is
  TOASTed on write.

**Two sets of credentials, and they must not cross.** The browser reads `.env.local`
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) — a publishable key (`sb_publishable_...`)
or a legacy anon key, **never** a secret/service_role key, since `VITE_` values are inlined
into the bundle. The pipeline reads `model/.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) —
the service_role key, which it needs precisely because no select policy exists. In both,
the URL must be the bare origin; a `/rest/v1` suffix produces 404s, since the client
appends the path itself.

Two behaviours worth knowing: with no credentials the app still runs, logging one warning
and dropping rows; and because Vite inlines `import.meta.env` at build time, `.env.local`
must exist **before** `npm run build` or the Supabase client is tree-shaken out of the
bundle entirely.

## Label integrity

The default-deny fix to `subjects.kind` is a schema property plus a manual operational
runbook. Since the 2026-10-18 rewrite it is default-deny **by construction** — it is simply how
the table is defined — and `subjects_label_has_provenance` is validated inline, so the old
manual `validate constraint` step is gone. The one remaining step is labelling bot accounts and
trusted human contributors, which cannot start before Phase 6 recruitment.

**`LABELING.md` is the authority** — its STATUS block is the single place that answers "is
the label fix actually live", and §5 has the exact statements. Read it before running any
remaining step, do not improvise them, and keep that STATUS block current by hand.

## Known defects — not yet fixed

Most of the earlier multi-user audit is now applied (**`AUDIT-2026-10.md`** is the record). What
remains:

- **Storage is managed by archive-and-prune, and the archive job does not exist yet.** The
  encoding shrink (`sampling_version` 1) plus 5-minute sessions put a 5-min session at ~2.6 MB, and
  the finite campaign (~150 sessions ≈ ~400 MB) fits Free **only if** `segments` is archived to
  Parquet and pruned before it passes ~150 MB (`STORAGE.md`). That archive job is the first
  unbuilt piece of `model/` (`src/TODO.md` §1). Watch `segments` size with
  `queries/campaign.sql` §3 from week one.
- **Ingest loss is still only visible client-side** (`console.warn`). `queries/campaign.sql` §4
  answers "is data landing" from the database; a `client_events` table is deferred (`src/TODO.md`
  §2). *(The old "failed `sessions` insert discards the run" defect is fixed — see D.1 /
  `AUDIT-2026-10.md` #4.)*
- **`model/` does not exist as code.** A reminder that the pipeline (and now the archive job) is a
  design (`model/DESIGN.md`, `STORAGE.md`), not a working program; do not cite a `model/src/*.py`
  file as if it runs. `schema.sql`'s comment above `v_training_segments` names `fetch_telemetry.py`
  as its consumer; that is a forward reference.

**Deliberately not defects** (recorded so they aren't "discovered" again): no predictions
table exists yet — correct, it should only be built once a model exists, and it must never
share a column with verified ground truth; there is no labelling helper function or RPC
endpoint — rejected on purpose, since PostgREST would auto-expose it to the anon key inlined
in the browser bundle; there is no email-based auto-enrollment for trusted contributors —
labelling is deliberately manual, by design, per `LABELING.md`; the landing page sharing no
CSS with `style.css` is intentional, not drift (see "Pages and styling").

## Verifying changes

`scene.js` needs WebGL and only runs in a browser, but `game.js`, `telemetry.js`,
`target.js` and `outbox.js` are DOM-light enough to drive headlessly in Node, which is how
the game logic has been validated (spawn distribution, hit/miss geometry, payload shape,
buffer isolation, outbox delivery). To do that:

- Stub `globalThis.document` with `addEventListener`/`removeEventListener` that capture
  handlers, then invoke them directly. Pass plain objects for `hud` and `crosshair`.
- `supabase.js` reads `import.meta.env`, which does not exist in Node and throws. Redirect
  the module to a capturing stub with a `node:module` resolve hook rather than changing the
  source.
- A harness outside the project cannot resolve the bare `three` specifier. Register a
  `node:module` resolve hook (via `register()` from an `--import`ed shim — on Windows pass it
  a `file://` URL) that maps `three` to `node_modules/three/build/three.module.js` and any
  `.../supabase.js` to a capturing stub; then drive `game.js` with a stub `document` that
  records handlers by type. This is how the segment-payload shape (`engaged_index`,
  `duration_ms`, and the `movesTargets` tx/ty/tz branch) is validated headlessly.
- `src/outbox.js` is pure and injectable: pass `send`/`store`/`currentOwner` stubs to check
  batching, idempotent dedupe (`23505` settles), retry-on-failure, the **`23503` transient** path,
  **owner-scoped skip** (a foreign-owner row is held, not dropped), the **bounded keepalive**, and
  IndexedDB replay — all with no browser. The `input_events` delta codec round-trips through
  `buildSegmentPayload` + an integer `cumsum`, and a segment survives a failed `insertSession`
  (the D.1 property) when `game.js` is driven against a stubbed failing session insert.
- `settings.js` needs `globalThis.window.localStorage` stubbed; a `Map` is enough.
  `createControls` needs a fake element carrying `ownerDocument` with add/removeEventListener.
- Sensitivity has a known-good reference: Valorant sens `0.4` @ `800` DPI is `40.8 cm/360`.

Movement is best checked by driving a routine directly on **synthetic timestamps**
(`routine.update(i * 8)`) rather than through the game and real sleeps: it is instant and
deterministic. Sample positions per frame, then derive speed and per-frame turn angle from
the displacement vectors. That is how "constant speed", "smooth arcs" and "abrupt cuts"
are verified as numbers rather than impressions.

After `npm run build`, confirm the payload split still holds: `dist/index.html` must not
reference the large Three-bearing bundle. Remember the entry names are inverted —
`main-*.js` is the landing page.

Browser-only criteria — pointer lock, `Esc` freezing the countdown and Resume continuing the
*same* run, the duration selector, the results screen, mouse feel, and rows actually landing
in the database — still need a human to confirm.

Database migrations (`schema.sql`) can only be verified against a live Supabase instance —
paste as one buffer (never in chunks, see the file's own header warning), then run the
verification queries in `LABELING.md` §6. There is no way to dry-run this locally.

## Conventions

Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Keep
modules small and single-purpose; `game.js` (~520 lines) and `supabase.js` (~450) are the
two largest and are the ones to split first if either grows. No dead code, no TODOs left
behind, no `.env.local` in git.

**Naming is split across three tiers on purpose — do not "unify" it.**

| Tier | Value | Where |
|---|---|---|
| Consumer brand | **`Aimprint`** | `index.html` `<title>`/`<h1>`, `README.md`, `package.json` `name`, PRD title, Google consent-screen app name, OG tags |
| Repository | **`PatternTrace-Simulation`** | Git remote only. Deliberately not renamed. |
| Internal plumbing | **`aim-trainer*`** | Storage keys, IndexedDB, env vars, schema |

Two internal keys remain, and both are **load-bearing and must not be renamed**:
`'aim-trainer-outbox'` (`outbox.js`) and `'aim-trainer.settings'` (`settings.js`).
Renaming the IndexedDB database **orphans undelivered telemetry already queued in users'
browsers, unrecoverably**; renaming the settings key silently resets everyone's DPI/sens.

Two others were retired and no longer exist anywhere in `src/`:
`'aim-trainer.free-sessions-used'` (with the free-run trial) and
`'aim-trainer.pending-google-consent'` (with the localStorage consent flag — later replaced by
a `profiles.consent_version` gate, which was itself removed with the whole consent system on
2026-10-18). Values left behind in a returning visitor's localStorage are inert and never read.

A future session seeing `Aimprint` in the UI and `aim-trainer` in storage is looking at a
deliberate decision, not an oversight.
