# TODO — deferred database / pipeline work

Updated **2026-10-10**, after the pre-collection hardening pass
(**`AUDIT-2026-10.md`** is the full record). Most of the earlier multi-user audit is now
applied to `schema.sql` and `src/`; this file is only what remains deliberately undone.

---

## Applied since the last revision — do NOT redo

These were open items here and are now in the tree (see `AUDIT-2026-10.md` for the how/why):

- **Orphan repair** (was item 1) — the idempotent `do $$ … $$` block runs in `schema.sql`
  after `create trigger on_auth_user_created`.
- **BRIN index on `segments.created_at`** (was item 2) — in the Indexes section.
- **Failed `sessions` insert no longer discards the run** (was 4b) — the client mints the
  session id and both session and segment rows go through durable outboxes; `23503` is now
  transient. `src/supabase.js`, `src/game.js`, `src/outbox.js`.
- **Effective batch size fixed** (was in 4d) — `FLUSH_DEBOUNCE_MS` 400 → 5000 in `src/outbox.js`.
- **Storage growth** (was 4a) — addressed by the `sampling_version = 4` shrink plus the
  archive-then-prune model. See **`STORAGE.md`**. The one piece still to build is the archive
  job itself (below).

---

## 1. The offline archive job — NOT YET WRITTEN

**Status:** needed by about session 60, when `segments` approaches the ~150 MB high-water mark
(`STORAGE.md` §4). Watch it with `queries/campaign.sql` §3 from the first week.

It is the first real code in `model/`. Its contract is specified in `model/DESIGN.md`
(§ "The offline archive job") and `STORAGE.md` §3: select aged sessions, write decoded Parquet
to the local drive **and** Supabase Storage, **verify row-count + sha256 before deleting**,
record `archive_manifest`, then `DELETE` the staging segments; re-runnable, with late-arrival
detection (`queries/campaign.sql` §4d). The delta/`tx-ty-tz` decode (`sampling_version = 4`)
lives here and nowhere else, guarded by a JS→Python round-trip test.

---

## 2. `client_events` ingest-telemetry table — deferred by decision

**Status:** deferred (audit "Known-remaining"). Every client-side delivery failure is currently a
`console.warn` in the user's own browser, so loss is invisible from the server side.
`queries/campaign.sql` §4 answers "is data landing" from the database side, which is enough for a
20-person campaign; a dedicated append-only `client_events` table (outbox depth, permanent drops,
delivery errors) is the fuller fix if visibility ever proves insufficient.

---

## 3. `segments.id` → UUIDv7 — deferred, irrelevant at this scale

Random UUIDv4 scatters inserts across index leaf pages. At the campaign's ~45k rows this costs
nothing; UUIDv7 would restore insert locality for any much larger future and needs an extension
or PG18. Not worth doing now.

---

## 4. ~~Open question — `profiles.display_name`~~ — RESOLVED 2026-10-17: dropped

Decided: **dropped.** It was always NULL, nothing wrote it, nothing read it, and the column grant
never made it writable, so there was nothing to preserve. `schema.sql` now carries
`alter table public.profiles drop column if exists display_name;`.

Dropped in the same pass, for the same "no code path ever writes this" reason:
`subjects.merged_into` (duplicate merging removed entirely), `sessions.bot_mode` (legacy Bot Mode
flag), and `segments.board_trajectory` (only the withheld `switching` routine ever wrote it).
Full record and the two ordering traps it exposed: `AUDIT-2026-10.md` follow-up section.

## 5. ~~ended_at / poll_hz never filled~~ — RESOLVED 2026-10-18

Both are now written by the client in one shot at run end (`closeSession` →
`sessions close own` policy, `grant update (ended_at, poll_hz)`), with
`queries/campaign.sql` §5 as the offline backfill if a close is lost. `poll_hz`
is the median pointer inter-arrival measured in `telemetry.js` (`pollHz`).
