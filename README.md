# Aimprint

A browser-based 3D FPS aim trainer built with Vite and Three.js. Every attempt
is timed, its mouse trajectory is buffered in memory, and the result is written
to a Supabase table.

## Requirements

- Node.js 18+ and npm
- A Chromium-based browser (Chrome or Edge) on Windows

## Install

```powershell
npm install
```

## Supabase setup

1. Create a Supabase project.
2. Open the SQL editor and run the contents of `schema.sql`. It creates the five
   v2 tables (`subjects`, `profiles`, `sessions`, `segments`, `session_metrics`),
   the signup trigger, and the append-only RLS policies. `anon` gets nothing:
   data is only ever written for a signed-in account.
   In **Authentication -> Providers -> Email**, keep the Email provider enabled.
   "Confirm email" is **on**: a new account has no session until the emailed link
   is clicked, which is deliberate — a verified address is how a participant is
   invited back for a later session, and repeat sessions matter more here than
   signup speed. Playing requires an account, so no run is ever lost to this.
   Confirmation mail needs **custom SMTP** (Authentication -> Emails); the
   built-in sender is capped at 2 emails/hour and will not work for real signups.
3. Copy `.env.example` to `.env.local` and fill in your project URL and anon key:

```powershell
Copy-Item .env.example .env.local
```

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_your-key
```

The URL is under **Project Settings → Data API**, the key under **Project Settings
→ API Keys**. Use the bare origin — `https://<project-ref>.supabase.co`, with no
`/rest/v1` path and no trailing slash; the client appends the path itself. Use the publishable key (`sb_publishable_...`), or the legacy anon
key on older projects — both carry the `anon` role when signed out and the
`authenticated` role once a user signs in, and `schema.sql` grants insert only to
`authenticated` (so a signed-out visitor writes nothing). Never use the secret or
`service_role` key: `VITE_` variables are inlined into the JS bundle and would be
readable by anyone.

`.env.local` is gitignored. Without it the trainer still runs — it logs one
warning and drops telemetry instead of persisting it.

## Run the dev server

```powershell
npm run dev
```

Open http://localhost:5173/, pick a routine, a difficulty and a session length
(5, 10 or 15 minutes), then press Start and left-click to shoot. `Esc` releases
the pointer and **pauses the countdown**; resuming continues the same run, so a
run spans as many pointer locks as you like. The run ends when its timer expires
or you pick "End run", and a results screen reports how much of it you played —
70% or more counts as a completed session.

## Build

```powershell
npm run build
```

The static bundle is emitted to `dist/`. Preview it with:

```powershell
npm run preview
```

## Synthetic data

There is no in-browser Bot Mode — `?bot=` and `bot.js` were removed. A client
flag is not a trustworthy label, so synthetic reference data is produced by
driving a bot in a real browser under a subject provisioned server-side as
`kind='synthetic'`. The human/synthetic label lives on `subjects.kind`, which no
client can write.

## Telemetry

One row in `segments` is one **segment** of play — a shape that fits every
routine. A segment closes with an `outcome`:

- `hit` / `miss` — a click in a destructible routine (flick, spidershot).
- `timeout` — a spidershot target expired before it was clicked; the failed
  attempt is kept, not discarded.
- `track` — a tracking routine (strafing) has no click, so it is logged in fixed
  ~1-second windows, and once more when the run is paused or ends.

(Two further routines — static flicking and target switching — exist in the
codebase but are withheld from the menu for this campaign; see
[AUDIT-2026-10.md](AUDIT-2026-10.md) #10.)

Every row carries the session id, the `routine` and `difficulty` it came from,
the `outcome`, the number of targets on screen and their layout at segment start
(`target_count`, `targets`), and — on click segments — time to click, dwell time,
target distance, and the click offset from target center. The `trajectory` is the
per-frame stream, one sample per rendered frame:

```
{ t, dx, dy, yaw, pitch, tx, ty, tz, on }
```

`dx`/`dy` are the raw device counts for that frame (they vary with DPI and OS
sensitivity); `yaw`/`pitch` are the camera's resulting angles in radians, which
are DPI-independent and the better signal for aim analysis or bot detection;
`tx`/`ty`/`tz` are the engaged target's world position that frame — so tracking
error is recoverable even while the target moves; and `on` is whether the
crosshair was over a target that frame. For static-target routines (flick,
spidershot) the `tx/ty/tz` columns are omitted — the target does not move, so its
position comes from the per-segment `targets` snapshot instead. The raw
`input_events` stream is stored delta-encoded (`{t0, dt, dx, dy}`, timestamps in
tenths of a millisecond). Both are `sampling_version` 4.

Delivery goes through a durable outbox (`src/outbox.js`): batched, retried with
backoff, mirrored to IndexedDB, replayed on the next page load, and scoped to the
signed-in account so a shared machine never ships one participant's rows under
another's login — so a network blip never loses recorded play.

## Biometric verification (deployed model)

The one piece of the project that is a **deployed, app-facing ML model**: a
behavioural-biometric verifier served from `model/serving/` (FastAPI) and called
by the game after a qualifying run ends. When a saved, signed-in session
finishes, the browser POSTs that session's segments to the service's `/verify`
endpoint; the service reads the subject's enrolled template **server-side with
the service key** (the template never reaches the browser — a client-readable
template would be replayable) and returns a trust result, shown as a quiet badge
on the results screen.

**It is a secondary signal only — never a sole authentication factor, and never a
gate.** Playing does not depend on it (`canPlay()` is untouched), and at this data
scale it is a research/capability demonstration, not a security control. Behaviour
drifts with fatigue, hardware and mood, so false rejects are expected. The badge,
the endpoint response, and this note all say so on purpose.

If `VITE_VERIFY_URL` is unset the feature is silently off (no badge, no error) —
the same spirit as running with no Supabase credentials. The live badge reads
"not enough history yet" until the subject is **enrolled** (`model/src/biometric/
enrol.py` writes a template with the service key) against a **trained** verifier
artifact; both require collected human data first.

**Deploying the service (Render, free plan):**

The repo ships a [`render.yaml`](render.yaml) Blueprint, so Render provisions the
service from it directly.

1. In Render: **New → Blueprint**, connect this GitHub repo. Render reads
   `render.yaml` and builds `model/serving/Dockerfile` with the **repository root**
   as the build context (the Dockerfile `COPY`s `model/src` and `model/models`).
2. Set the service env vars `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the Render
   dashboard (the service key lives only here and in `model/.env`, never in the
   browser bundle). Optionally `CORS_ALLOW_ORIGINS` for extra origins.
3. **Pickle portability is the one gotcha:** a joblib artifact must be produced on
   the same Python/numpy/sklearn stack that serves it. The image is `python:3.13`;
   training currently runs on 3.15. Train the verifier inside the serving image
   (or pin both stacks) before deploying — see the note at the top of the
   Dockerfile.
4. Point the browser at it: set `VITE_VERIFY_URL` to the service origin (bare, no
   `/verify` suffix) — in `.env.local` for local dev, and in the Vercel project's
   environment variables for production (Vite inlines it at build time, so the
   production site must be rebuilt after setting it).

A free Render web service spins down after ~15 min idle and wakes in ~1 min. The
game sends a warm-up ping to `/health` when a run **starts**, so the service is
awake well before the post-session verify call fires — the cold start never lands
on the player.

## Notes

- Sensitivity is set on the home screen (mouse DPI + in-game sens on the Valorant
  scale) and persists to localStorage; `constants.js` only holds the defaults. No
  smoothing or acceleration is ever applied to mouse input.
- Targets spawn in a 3D volume, so distance varies per attempt. Target radius is
  fixed in world space, which means far targets really are harder to hit.
- HUD counters are per run: they reset when a run starts, which is also when a
  new `session_id` is generated. Pausing and resuming keeps both.
