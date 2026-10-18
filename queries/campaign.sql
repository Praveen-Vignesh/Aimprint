-- queries/campaign.sql — read-only operator queries for the collection campaign.
--
-- Run these in the Supabase SQL editor with the service key (they read subjects,
-- auth.users and segments, which the client cannot). None of them write. They
-- answer the three questions the campaign actually has: who still owes sessions,
-- is the database about to fill, and is data landing intact.
--
-- Target: ~20 human contributors x >=5 sessions across >=3 separate days, plus
-- ~5 bot variants (one subject each). See STORAGE.md and model/DESIGN.md.

-- ===========================================================================
-- 1. PER-SUBJECT PROGRESS  — "who do I chase?"
-- ===========================================================================
-- Biometric identification needs depth: >=5 sessions across >=3 distinct days.
-- `days` is the binding number, not `sessions` — five sessions in one afternoon
-- do not satisfy the protocol (same-day runs share warm-up/seating state that
-- can masquerade as identity). `enough` flags who is done.
select
  sub.subject_id,
  u.email,
  sub.kind,
  sub.cohort,
  count(s.id)                                              as sessions,
  count(distinct (s.started_at at time zone 'UTC')::date) as days,
  round(sum(coalesce(s.planned_duration_ms, 0)) / 60000.0, 1) as planned_minutes,
  (count(s.id) >= 5 and count(distinct (s.started_at at time zone 'UTC')::date) >= 3)
                                                           as enough
from public.subjects sub
  left join public.profiles p on p.subject_id = sub.subject_id
  left join auth.users u       on u.id = p.user_id
  left join public.sessions s  on s.subject_id = sub.subject_id
group by sub.subject_id, u.email, sub.kind, sub.cohort
order by sub.kind, enough, days desc;

-- ===========================================================================
-- 2. COLLECTION PROGRESS  — against the target, by class
-- ===========================================================================
select
  kind,
  coalesce(cohort, '(none)') as cohort,
  count(*)                   as subjects
from public.subjects
group by kind, cohort
order by kind, cohort;

-- Label state at a glance (mirrors LABELING.md section 6).
select kind, kind_source, count(*)
from public.subjects
group by 1, 2 order by 1, 2;

-- ===========================================================================
-- 3. DATABASE SIZE  — the archive trigger (see STORAGE.md section 4)
-- ===========================================================================
-- Archive + prune when segments passes ~150 MB; never let it exceed ~200 MB
-- (VACUUM FULL needs ~2x the table size, which would blow the 500 MB Free cap).
-- total_bytes here INCLUDES the TOAST table, where the payload actually lives.
select
  pg_size_pretty(pg_total_relation_size('public.segments'))         as segments_total,
  pg_size_pretty(pg_relation_size('public.segments'))               as segments_heap,
  pg_size_pretty(pg_total_relation_size('public.segments')
               - pg_relation_size('public.segments'))               as segments_toast_plus_idx,
  (select count(*) from public.segments)                            as segment_rows,
  pg_size_pretty(pg_database_size(current_database()))              as database_total;

-- ===========================================================================
-- 4. HEALTH  — is data landing intact?
-- ===========================================================================

-- 4a. Orphaned auth.users (no profile) — these silently drop ALL their telemetry.
--     Expect zero. If not, re-run schema.sql (its orphan-repair block heals them).
select u.id, u.email, u.created_at
from auth.users u
  left join public.profiles p on p.user_id = u.id
where p.user_id is null;

-- 4b. Sessions with zero delivered segments — a real delivery failure. Since
--     the SESSION_MIN_PLAY_MS gate (src/constants.js) withholds the session row
--     AND its segments together until a run passes one minute, an abandoned run
--     now writes NOTHING rather than an empty session row — so a session here
--     with no segments is no longer "they quit early", it is "segments were lost
--     after the session landed". Worth a look either way.
select s.id, s.subject_id, s.routine, s.started_at, s.planned_duration_ms
from public.sessions s
  left join public.segments g on g.session_id = s.id
  left join public.archive_manifest a on a.session_id = s.id
where g.session_id is null
  and a.session_id is null
  and s.started_at < now() - interval '1 hour'
order by s.started_at desc;

-- 4c. Segment-index gaps within a session — a dropped or never-enqueued segment
--     leaves a hole in 0..max. Expect zero rows. (Only meaningful for sessions
--     not yet archived.)
select
  g.session_id,
  count(*)              as present,
  max(g.segment_index)  as max_index,
  max(g.segment_index) + 1 - count(*) as missing
from public.segments g
  left join public.archive_manifest a on a.session_id = g.session_id
where a.session_id is null
group by g.session_id
having max(g.segment_index) + 1 <> count(*)
order by missing desc;

-- 4d. Late arrivals after archival — a pruned session that has live segments
--     again (an IndexedDB replay landed after the archive). Re-run the archive
--     job for these; it is idempotent. Expect zero rows normally.
select a.session_id, a.archived_at, a.segment_count, count(g.id) as live_segments
from public.archive_manifest a
  join public.segments g on g.session_id = a.session_id
where a.pruned_at is not null
group by a.session_id, a.archived_at, a.segment_count
order by a.archived_at desc;

-- ===========================================================================
-- 5. BACKFILL ended_at / poll_hz  — safety net for a close that did not land
-- ===========================================================================
-- The client closes its own session row at run end (ended_at + poll_hz, through
-- the single-shot `sessions close own` policy). If that one request is lost to
-- a network blip or a hard crash, the columns stay null and these two UPDATEs
-- recompute them from the segments that DID arrive. Both are idempotent (the
-- `is null` guard) and safe to run any time; run them before an archive pass so
-- the archived sessions carry the values.

-- 5a. ended_at, from the last segment of each session. Server-anchored
--     (started_at + active play), so it does not depend on a client clock. NOTE
--     this is active-play end, not wall-clock end — the same figure the client
--     would have written, minus paused spans, which are not recorded anywhere.
update public.sessions s
   set ended_at = s.started_at
                + make_interval(secs => (t.ms / 1000.0)::double precision)
  from (select session_id, max(started_at_ms + coalesce(duration_ms, 0)) as ms
          from public.segments group by 1) t
 where t.session_id = s.id
   and s.ended_at is null;

-- 5b. poll_hz, as the median pointer inter-arrival. input_events.dt is in TENTHS
--     of a millisecond and dt[0] is defined as 0, so ordinality > 1 skips that
--     leading zero and hz = 10000 / dt_tenths. This matches telemetry.js pollHz
--     exactly — median, so one backgrounded-tab gap cannot drag it down.
--
--     HEAVY: reads input_events for every segment, which means the whole TOAST
--     table. Run it on the un-archived tail only, and expect it to take a while.
update public.sessions s
   set poll_hz = m.hz
  from (
    select g.session_id,
           10000.0 / nullif(
             percentile_cont(0.5) within group (order by e.txt::numeric), 0) as hz
      from public.segments g
      cross join lateral jsonb_array_elements_text(g.input_events -> 'dt')
                   with ordinality as e(txt, ord)
     where g.input_events is not null
       and e.ord > 1
     group by g.session_id
  ) m
 where m.session_id = s.id
   and s.poll_hz is null;
