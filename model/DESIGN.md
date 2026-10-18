# `model/` — offline pipeline design

**Status: no code exists yet.** `model/` currently holds only this file, `.env.example`,
`requirements.txt`, and the gitignored `data/` and `models/` directories. There is no
`src/`, no `__init__.py`, no `config.py`, no `archive_telemetry.py`, no `fetch_telemetry.py`
and no `features.py` — the whole package is the next task. The **first** piece to build is the
archive job (see "The offline archive job"), because it is what keeps the Free-tier database
under its limit during collection; the fetch/feature/training code follows.

This document records the design decisions already made, so whoever builds it implements
them consistently rather than re-deriving them. **Nothing below is code you can run
today.** Do not cite a `model/src/*.py` file as if it exists.

## What this is

An offline Python program that pulls telemetry back out of Supabase and trains a
human-vs-bot classifier. It is a separate program, not a backend: nothing in `src/`
imports it, nothing in it reaches the browser, and it runs by hand after the fact. The
PRD's "no Python backend" means the *game* has no server; it does not forbid `model/`.

`requirements.txt` is a separate dependency set from the browser app's and is not bound by
the app's two-dependency rule.

## Planned setup and commands

A `.venv` in `model/`, `pip install -r requirements.txt`, and a `model/.env` copied from
`model/.env.example`:

```powershell
cd model
.venv\Scripts\Activate.ps1
python -m src.archive_telemetry --older-than 7d     # move aged sessions to Parquet, then prune
python -m src.fetch_telemetry --routine flick --out data/flick.parquet
python -m src.features --in data/flick.parquet --out data/flick_features.parquet
```

Both scripts run as modules (`python -m src.x`) from `model/`, because they use relative
imports; `python src/features.py` would fail. `data/` and `models/` are gitignored —
everything in them is regenerable.

## Credentials

`model/.env` holds `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` — the **service_role** key,
which the pipeline needs precisely because `segments` has no select policy. This must
never cross with the browser's `.env.local`, whose `VITE_`-prefixed values are inlined
into the shipped bundle. The URL must be the bare origin; a `/rest/v1` suffix produces
404s, since the client appends the path itself.

## Two stages

Each is a module with a `--in`/`--out` CLI, so datasets are files on disk rather than
state in a notebook.

### `fetch_telemetry.py`

**The authoritative dataset is the archive, not the view.** Because segments are archived to
Parquet and pruned from Postgres once the staging table fills (see `STORAGE.md` and the archive
job below), by the end of the campaign most data lives in `archive_manifest ⋈ subjects` (Parquet
on disk/Storage joined to the live `subjects` row for its label), and `v_training_segments` holds
only the **un-archived tail**. The fetch stage must read both and union them. Resolving the label
from `subjects` at read time — not from a value frozen into the archive — is what keeps labelling
retroactive (`LABELING.md`): a contributor labelled after their sessions were archived still
classifies correctly.

For the tail it pages through **`v_training_segments`**, and two properties are mandatory:

- **Keyset pagination, never `LIMIT`/`OFFSET`.** The view has no intrinsic order, so `OFFSET`
  both skips and duplicates rows (and is O(n²)). Order by `(segment_created_at, segment_id)` and
  page on the last-seen pair. PostgREST caps a single response at 1000 rows, so the loop is not
  optional regardless.
- **Filter the label with `subject_kind in ('human','synthetic')`, not `is_human is not null`.**
  `is_human` is a `CASE` expression, so the latter is non-sargable — the planner falls back to a
  0.5 default selectivity and full-scans `segments` plus its entire TOAST table. `subject_kind`
  is a plain column.
- Incremental pulls must **lag** (`segment_created_at < now() - interval '1 hour'`): a row can
  commit after your snapshot with an earlier `created_at` and be missed otherwise.

The view emits `subject_id` (one subject row is one identity — duplicate merging was removed, so
there is no collapse step) plus `duration_ms`, runs `security_invoker`, and also carries `segment_created_at`,
`subject_kind_source`, `subject_cohort` and `subject_labeled_at`. (There is no
`session_ended_at` — the `ended_at` column was dropped 2026-10-18 — and no
`subject_consent_version` — consent was removed the same day. `poll_hz` is still present but is
derived offline; the archive job computes it since it already decodes every segment.)

**Decoding (`sampling_version = 1`):** `input_events` is delta-encoded as `{t0, dt, dx, dy}` in
tenths of a millisecond (reconstruct `t_ms = (t0 + cumsum(dt)) / 10` with an **integer** cumsum),
and `trajectory` omits `tx/ty/tz` for static routines (fill them from `targets[engaged_index]`).
In practice the fetch stage never does this itself — the **archive job decodes once on the way
out** (below), so Parquet on disk is already absolute. Only a direct read of the un-archived tail
needs the decoder, which must share code with the archive job and its round-trip test.

**`--label` must be three-state** (`human` | `synthetic` | `any`), not a boolean.
`is_human` is nullable — `true`/`false`/`NULL`, where `NULL` is an unlabelled subject (the
default state of every public signup). A two-state `--is-human` flag has no way to express
"exclude the unlabelled", which is mandatory before fitting. It must default to excluding
`NULL` rows, and they must be dropped with `where is_human is not null`, never coerced or
imputed. Silently training on unlabelled strangers is the exact bug the default-deny label
exists to prevent.

### `features.py`

Flattens one segment into one row. The parts that encode decisions already made:

- **Click-only fields stay NaN on non-click rows.** `time_to_click_ms`, `dwell_ms` and the
  click offsets do not exist on a `timeout` or `track` segment, and must not be imputed —
  a fabricated reaction time would teach the classifier a lie. The v2 schema already
  enforces the same thing as a check constraint.
- **Angular features come from `yaw`/`pitch`, input features from `dx`/`dy`.** The former
  are DPI-independent and comparable across users; the latter are raw counts and are only
  comparable once `sessions.dpi` is known.
- `_coerce_frames` must accept a list, a JSON string, or a Python `repr` string, because
  `to_csv()` stringifies nested structures with single quotes that `json.loads` rejects.

## The offline archive job

New, and the first `model/` code that must exist (needed around session 60 — see `STORAGE.md`
§4). It keeps the Free-tier database under its limit by moving aged data out to Parquet. Runs by
hand with the service key.

Steps, in order:

1. Select sessions older than a lag (`started_at < now() - interval '7 days'`, comfortably longer
   than any IndexedDB outbox replay) with no `archive_manifest` row.
2. Read their segments, **decode to absolute values** (the `sampling_version = 1` delta /
   omitted-`tx/ty/tz`, above), and write one Parquet per session with zstd, Hive-partitioned:
   `segments/sampling_version=1/routine=flick/session_id=<uuid>.parquet`. Carry `subject_id`,
   never a resolved label.
3. Write to the **local drive and** upload to the private Supabase Storage bucket.
4. **Verify before deleting — a hard gate.** Re-read the Parquet; assert its row count and a
   sha256 over the sorted `(session_id, segment_index)` pairs equal the database's. This data
   cannot be re-collected, so no delete happens unless the written copy is proven complete.
5. Insert the `archive_manifest` row (session_id, subject_id, routine, difficulty,
   sampling_version, segment_count, byte_size, storage_path, local_path, content_sha256), then
   `DELETE` the segments and set `pruned_at`.
6. **Idempotent + late-arrival safe:** a manifest row whose session later has live segments again
   (`queries/campaign.sql` §4d) is a replay that landed after archival — re-archive, re-verify,
   re-prune.

The decoder here is the single source of truth for the v1 codec; a JS→Python round-trip test
(encode a known stream in the harness, decode here, assert bit-exact including the integer cumsum)
guards it.

## Training

- **Split train/test by `subject_id` (GroupKFold), never by row.** The view's
  `subject_id` is that grouping key (one row, one identity — no merging). Rows from one subject are
  correlated samples of one motor process, not independent observations — the effective sample
  size is the number of **subjects** (~20 human + ~5 synthetic), not the ~45k rows.
- **Leave-one-bot-variant-out is the headline evaluation.** Hold out an entire `cohort`
  (`bot_v1_linear`, …) from training and test on it. Accuracy that holds on an unseen variant
  means a bot *detector*; accuracy that needs every variant present means a bot *recogniser*,
  which is far weaker. One subject per variant (enforced by `cohort`) is what makes this possible.
  Keep the classes roughly balanced at the subject level and use `class_weight='balanced'` — bot
  rows are cheap to over-generate and 10× more of them just teaches the prior.
- **Train once with the hardware block (`dpi`/`refresh_hz`/`device_fingerprint`) and once
  without, then compare.** If bots and humans run on visibly different hardware, a model can score
  near-perfectly by learning the hardware rather than the aim, then collapse on unseen subjects.
  This matters doubly now that biometric identification is in scope.
- At ~20 human subjects the accuracy estimate carries roughly ±8–9 pp (held-out-subject), which is
  enough to defend a number and compare feature sets but not to claim a production classifier —
  frame v1 as a strong proof of concept. The lever for a tighter result is **more subjects and
  more bot variants**, never more rows per subject.
- **Never write a model prediction back into `subjects.kind`.** Ground truth is what a
  person decided; a retrain that consumes its predecessor's guesses amplifies its own
  errors, silently, across every future retrain. No predictions table exists yet — correct,
  it should only be built once a model exists, and it must never share a column with
  verified ground truth.

### Biometric identification (the second model)

The depth-oriented task — "is this the same person who played last week" — and why per-subject
session count matters. Protocol:

- **Enrol on sessions 1–3, verify on sessions 4–5**, per subject. This is why the campaign asks
  for ≥5 sessions across ≥3 separate days: same-day sessions share warm-up, seating and input
  state that the model can learn as identity, so verification on a *later day* is what proves it
  learned the person rather than the sitting.
- It is offline evaluation only (train once, report enrol-vs-verify accuracy) — there is no live
  template table and the archive-and-prune model is built on that assumption (`AUDIT-2026-10.md`,
  auth-scope decision). A live check would need a small permanent per-subject signature table,
  which does not exist and is out of scope.
- It reuses the same trajectory/`yaw`/`pitch` features as the bot detector; only the labels and
  the split differ (group and split by the enrol/verify session set, still never by row).

## Staying in sync with the game

Adding a field to `sampleFrame()` in `src/telemetry.js` without teaching `_segment_features`
about it would silently train on the old feature set. `SAMPLING_VERSION` (`src/constants.js`)
is stamped on every `sessions` row and is what stops a pull mixing rows from two different
samplers — **filter on it** rather than assuming one shape. It is currently **1** (delta-encoded
`input_events`, `tx/ty/tz` omitted for static routines); it was reset from 4 with the 2026-10-18
data wipe, so there is no older shape in the database to exclude.

## Verifying this side

No database is needed to exercise it: `build_features()` should take a DataFrame, so a
handful of hand-built segment dicts (one per outcome — `hit`, `miss`, `timeout`, `track`)
is enough to check that click-only columns stay NaN off click rows and that a single-frame
segment does not divide by zero. Pull real rows only when the question is about the data
rather than the code.
