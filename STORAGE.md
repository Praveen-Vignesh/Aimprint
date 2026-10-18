# STORAGE.md — how telemetry is stored, shrunk, and archived

This project collects a **finite, one-off** dataset: ~20 human contributors and ~5 bot
variants, roughly 150 sessions, then training and done. That framing decides everything below.
The storage design is sized for a campaign, not a service.

## 1. What a session costs

At 5-minute sessions (the campaign default), with the `sampling_version = 1` encoding below:

| | per segment | per 5-min session (~300 segments) |
|---|---|---|
| Raw JSON (pre-shrink) | ~15 kB | ~8.5 MB (at 10 min) / ~4.3 MB (at 5 min) |
| **After the two lossless changes** | ~8.7 kB | **~2.6 MB** |

The whole campaign — ~150 sessions — is therefore **~400 MB of good data**, plus slop for dev
runs, bot debugging and re-collection. That fits comfortably in what Supabase provides, as long
as the staging table is kept from growing without bound (§4).

## 2. The `sampling_version = 1` encoding (lossless)

Two changes, both approved as lossless in *signal*, implemented in `src/telemetry.js`:

1. **`input_events` is delta-encoded.** Instead of `{t:[0, 1.0, 2.0, …], dx, dy}` with absolute
   millisecond timestamps, it is `{t0, dt:[0, 10, 10, …], dx, dy}` where `t0` and every `dt` are
   **integers in tenths of a millisecond** and `dt[0] = 0`. Absolute time reconstructs as
   `(t0 + cumsum(dt)) / 10`. The gaps are ~10 (≈1 ms at 1000 Hz), one or two digits instead of
   five, and this is the single largest array in the database. Integers make the `cumsum` exact;
   a float cumsum over hundreds of terms would drift. Rounding happens once, in `recordInput`,
   *before* the delta is taken.
   - The 0.1 ms resolution is 10× finer than the ~1 ms polling interval, so no real timing
     signal is lost — the poll interval is the measurement floor.
2. **`tx/ty/tz` are omitted for static-target routines.** `flick` and `spidershot` do not move
   their target, so within a segment the engaged target's position is constant — and that
   position is already stored in the `targets` snapshot at `engaged_index`. The three per-frame
   columns are omitted and reconstructed offline from the snapshot. Only `strafing` (and the
   withheld `switching`) declare `movesTargets: true` and keep them.

**`SAMPLING_VERSION` is 1.** It was reset from 4 when all data was wiped on 2026-10-18, so every
row in the database is this one shape — there is no older version to exclude. The rule still
stands for any future change (bump it, filter on it in a pull); there is just nothing to filter
against today.

**Decoding lives in exactly one place — the offline archive job (§3).** It writes absolute,
decoded values into Parquet, so the feature pipeline never sees the delta form and there is one
codec to get right, guarded by one round-trip test.

## 3. Archive-then-prune (the storage model)

Postgres is a **rolling staging buffer**; the Parquet archive is the dataset.

```
Browser ──(outbox, ingest path unchanged)──► Postgres segments   (staging)
                                                  │
                                      archive job (offline Python, service key)
                                                  │  decode deltas → absolute, Parquet + zstd
                                                  ├──► local hard drive   (working copy)
                                                  └──► Supabase Storage    (durable copy)
                                                  │
                                      verify: row count + sha256 of (session_id, segment_index)
                                                  │
                                      record in archive_manifest (Postgres, permanent)
                                                  │
                                      DELETE the archived segments
Never pruned: subjects, profiles, sessions, session_metrics, archive_manifest
```

Why this shape and not client-upload-to-Storage:

- **The browser never touches Storage.** The bucket is private with no client policies; only the
  service key (which bypasses Storage RLS) reads or writes it. The "an account cannot download
  its own biometric template" guarantee is preserved exactly — the same posture as `segments`
  having no select policy.
- **The `23505` idempotency contract is untouched**, along with the outbox, the keepalive flush
  and every RLS policy. Nothing from `SEGMENT_DELIVERY_INCIDENT.md` is rebuilt.
- **Labels stay live.** The archive stores `subject_id` only; `kind` and `cohort` are
  joined from the permanent `subjects` table at train time. So a
  contributor labelled *after* their sessions are archived still reclassifies retroactively —
  the property `LABELING.md` depends on.

The job's contract is specified in `model/DESIGN.md` (§ "The offline archive job"). The hard
rule: **verify the written Parquet against the database before deleting anything.** This data
cannot be re-collected.

## 4. Operating the Free tier

Free gives **500 MB database, 1 GB Storage, 5 GB/month egress**, and the project
**pauses after ~7 days of inactivity**.

- **The database limit is a hard stop** — exceed 500 MB and the project goes read-only, which
  breaks collection. So the archive job is not optional.
- **`DELETE` does not shrink the table.** It marks rows dead; autovacuum makes the pages reusable
  *by this same table*, but space is not returned to the OS. The table therefore **plateaus**
  near its high-water mark rather than shrinking. The reported database size will *stop going up*
  after a prune, not go down — that is the mechanism working, not a failure.
- **Operating rule: archive + prune whenever `segments` passes ~150 MB** (≈60 sessions). Over the
  campaign that is about three archive runs. The `queries/campaign.sql` size query reports the
  current figure; watch it from the first week.
- **Never let `segments` exceed ~200 MB.** `VACUUM FULL` (the only way to actually reclaim disk,
  if ever needed) needs ~2× the table size in temp space — a 300 MB table needs 600 MB, over the
  limit, and the command fails. Staying under ~200 MB keeps that escape hatch open.
- **Autovacuum is tuned for the churn** in `schema.sql` (`toast.autovacuum_vacuum_scale_factor =
  0.05`), because the payload bytes live in the TOAST side table.
- **Keep the project awake** during recruitment: between collection batches, a weekly ping or
  the `queries/campaign.sql` size check is enough; a paused project while a contributor is trying
  to play is a lost session.
- **Storage headroom:** archive ≈ 1–1.5 MB/session × 150 ≈ 150–225 MB against the 1 GB Storage
  limit; three archive runs reading ~150 MB each is ~450 MB against the 5 GB egress — both
  comfortable.

## 5. Why not partition

Partitioning `segments` by time would let a prune be `DROP TABLE` on a partition (instant, space
returned to the OS). It is deliberately **not** used, because it is unnecessary for a buffer that
plateaus (§4) and it carries a trap: a partitioned table requires the partition key in every
unique constraint, so `segments_session_order` would become
`(session_id, segment_index, created_at)` — and `created_at` defaults to `now()`, so a **retried
row would get a fresh timestamp and insert as a duplicate instead of raising `23505`**, silently
destroying the outbox's idempotency. If the project ever outgrows a single buffer and does
partition, it must be on a value that is deterministic per row (e.g. a `session_started_at`
copied from `sessions` by a `BEFORE INSERT` trigger), never on `now()`.

## 6. What would change at larger scale

None of this is a permanent architecture; it is right for a one-off ~400 MB campaign. If the
project ever became a running service, the next steps — in order — would be: measure real
MB/session; add a retention window; partition on a deterministic key (§5); and move to
client-upload-to-Storage with the idempotency contract rebuilt on deterministic object paths and
a two-system consent-withdrawal runbook. That is explicitly out of scope now.
