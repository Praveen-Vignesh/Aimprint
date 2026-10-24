# Aimprint

Aimprint is a research sandbox for one question: **can the way a person moves a
mouse identify them, and can it tell a real person from a script?**

It is a browser-based 3D FPS aim trainer (Vite + Three.js) that records every
mouse movement and click during timed runs. That telemetry feeds two offline-trained
models, a **bot detector** and a **behavioural biometric verifier**, which are
deployed as a small FastAPI service.

> **Status: paused.** This was a one-off data-collection campaign and a learning
> project. The models are proof-of-concept scale. Their accuracy and error rates are
> not production claims, and the verifier is a research demonstration, not an
> authentication factor.

## What's in here

| Part | What it does | Where |
|---|---|---|
| Aim trainer | Browser game, three routines, timed runs, telemetry capture | `src/`, `index.html`, `play.html` |
| Telemetry store | Supabase Postgres schema with row-level security, append-only | `schema.sql`, `migrations/` |
| Bot driver | Playwright drives the real game with scripted controllers to produce labelled synthetic data | `bot_driver/` |
| ML pipeline | Fetch, decode, feature extraction, training, evaluation, enrolment | `model/src/` |
| Verify service | FastAPI model server, Dockerised, deployed on Render | `model/serving/`, `render.yaml` |

## How the models work

Each run produces a stream of **segments**. A segment is one span of play that
ends in a click, a timeout or a window boundary. The pipeline turns each segment
into 19 behavioural features, such as:

- **Ballistic shape:** peak speed, time to peak, submovement count.
- **Smoothness:** SPARC (spectral arc length) and jerk.
- **Path:** straightness and how directly the crosshair travels.
- **Tremor:** 8–12 Hz band power from the raw input stream.
- **Click timing:** time to click, dwell, and aim offset (click segments only).

**Hardware is excluded on purpose.** DPI, sensitivity and refresh rate identify
the rig, not the person or the behaviour. A model that learns the mouse learns the
wrong thing, and those fields are not reliably available at serve time anyway.

**Bot detector.** A per-segment classifier (logistic regression, random forest or
gradient boosting, chosen by a nested, subject-grouped bake-off) outputs
P(bot) for each segment. A subject's verdict is the mean of those probabilities.
Labels come from six scripted controllers in `bot_driver/`, which differ in aim
strategy and reaction timing.

**Biometric verifier.** Not a classifier. Each enrolled person gets a template of
per-feature means and variances. A new session is scored by its root-mean-square
z-score distance to that template, and a threshold is set from the equal error
rate of genuine and impostor trials.

## Architecture

```
Browser (Vercel)                 Offline (your machine)
  aim trainer                      fetch_telemetry  (service key)
    ├─ outbox → Supabase             ├─ codec → features
    └─ POST /verify  ──┐             ├─ evaluate + train  → registry
                       │             └─ enrol → biometric_templates
                       ▼                      │
              FastAPI on Render  ◄── artifacts from Supabase Storage
              /verify  /bot-score  /health
```

Telemetry goes straight from the browser to Supabase through an append-only
insert policy. The client never reads raw segments back, and the service key is
used only server-side. Model inference runs on the server, never in the browser.

## Requirements

- Node.js 18+ and npm
- A Chromium-based browser (Chrome or Edge)
- Python 3.13 for the model pipeline and serving image (see the deployment notes)

## Install

```powershell
npm install
```

## Supabase setup

1. Create a Supabase project.
2. Open the SQL editor and run `schema.sql` on the empty project. It creates the
   eight tables (`subjects`, `profiles`, `sessions`, `segments`,
   `session_metrics`, `archive_manifest`, `predictions`, `biometric_templates`),
   the signup trigger, and the RLS policies. `anon` gets nothing, and data is only
   written for a signed-in account.
3. In **Authentication → Providers → Email**, keep the Email provider enabled with
   "Confirm email" on. A verified address matters for repeat sessions. Confirmation
   mail needs **custom SMTP** (Authentication → Emails), since the built-in sender
   is capped at 2 emails per hour.
4. Copy `.env.example` to `.env.local` and fill in your project URL and publishable key:

```powershell
Copy-Item .env.example .env.local
```

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_your-key
```

The URL is under **Project Settings → Data API**, and the key is under **Project
Settings → API Keys**. Use the bare origin, with no `/rest/v1` path and no trailing
slash. Use the publishable key (`sb_publishable_...`), or the legacy anon key on
older projects. **Never use the secret or `service_role` key here.** `VITE_` variables
are inlined into the JavaScript bundle, so anyone could read them.

`.env.local` is gitignored. Without it the trainer still runs. It logs one warning
and drops telemetry instead of saving it.

## Run the dev server

```powershell
npm run dev
```

Open http://localhost:5173/, pick a routine, a difficulty and a session length
(5, 10 or 15 minutes), press Start, and left-click to shoot. `Esc` releases the
pointer and pauses the countdown. Resuming continues the same run. The run ends
when the timer expires or you choose "End run".

## Build

```powershell
npm run build
npm run preview
```

The static bundle goes to `dist/`.

## Running the bot driver

```powershell
cd bot_driver
npm install
npx playwright install chromium
npm run bot -- --email <bot-email> --password <password>
```

Bot accounts are created and labelled by `model/src/bot_detection/provision_bot_subjects.py`
using the service key. The driver does not ship with any credential. Pass the password
explicitly. `fleet.js` runs the whole cohort and also requires `--password`.

## Model pipeline

```powershell
cd model
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

python -m src.bot_detection.pipeline --routine flick
python -m src.biometric.pipeline --enrol-sessions 3
```

Both pipelines read `model/.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`). Trained
artifacts go to `model/models/` and are gitignored. Upload them with
`python -m src.common.artifact_store --upload --model-type <type>`.

Tests: `pytest model/tests`.

## Biometric verification service

The game calls the verify service after a qualifying signed-in run. The service
reads the subject's template server-side with the service key, so the template
never reaches the browser. The response is a trust result shown as a badge on the
results screen.

**It is a secondary signal only, never a gate.** Playing does not depend on it
(`canPlay()` is unaffected). If `VITE_VERIFY_URL` is unset, the feature is silently
off.

**Deploying (Render, free plan):** the repo includes a `render.yaml` Blueprint.

1. In Render, choose **New → Blueprint** and connect this repo. It builds
   `model/serving/Dockerfile` with the repository root as the build context.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the Render dashboard. The
   service key lives only there and in `model/.env`.
3. **Match the Python stack.** The joblib artifact must be produced on the same
   Python, numpy and scikit-learn versions that serve it. The image uses Python
   3.13, so train inside that stack, or pin both sides, before deploying.
4. Set `VITE_VERIFY_URL` to the service origin (no `/verify` suffix) for local dev
   and in the Vercel environment. Vite inlines it at build time, so rebuild the
   site after changing it.

A free Render service sleeps after about 15 minutes idle. The game pings `/health`
when a run starts, so the service is awake before the verify call.

## Limitations

- **Data scale.** The campaign collected about a dozen real participants. That is
  far too few to support any accuracy or error-rate claim.
- **Bot detector.** Its near-perfect scores come from synthetic bots that are too
  easy to separate from people. When the most human-like controller was held out,
  the detector caught none of its accounts.
- **Biometric verifier.** At this sample size the equal error rate was close to
  chance. Treat it as a demonstration of the pipeline, not a security control.
- **Security.** The verify and bot-score endpoints are unauthenticated and not
  rate-limited. Deploy them only with auth in front, or not at all.

## Notes

- Sensitivity is set on the home screen (mouse DPI and in-game sensitivity on the
  Valorant scale) and saved to localStorage. No acceleration or smoothing is applied
  to mouse input.
- Target radius is fixed in world space, so far targets really are harder to hit.
- Telemetry is append-only. The client never updates or deletes rows.

## License

No license has been chosen yet. All rights are reserved by the author until one is added.
