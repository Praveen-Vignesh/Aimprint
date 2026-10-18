-- queries/schema_parity.sql — does the LIVE database match schema.sql?
--
-- Run this in the Supabase SQL editor with the service key BEFORE collecting any
-- real data. schema.sql is now a one-shot create-from-scratch file (no IF NOT
-- EXISTS, no ALTER migration path), and it changed after the 2026-10-18
-- finalisation — ended_at, the `sessions close own` UPDATE policy and the
-- client poll_hz write were all removed. So the live database may be an OLDER
-- shape, or the mid-state that still has ended_at. This script finds out.
--
-- HOW TO READ IT: every numbered check is written to return ONLY deviations.
-- An all-empty run (every check 0 rows, and the scalar checks showing the
-- expected value) means live == schema.sql. Any rows returned name exactly what
-- is wrong. None of these queries write.
--
-- IF IT IS NOT CLEAN, re-apply the schema by ONE of:
--
--   PATH A — teardown + recreate  (recommended for a fresh campaign; destroys
--            all current data, which is disposable test data):
--     1. Run the commented TEARDOWN block from the header of schema.sql.
--     2. Paste schema.sql as ONE buffer.
--     3. Re-run this script; expect it clean.
--
--   PATH B — targeted delta  (ONLY if you must keep existing accounts/test
--            data AND check 1 shows the live DB is the mid-state, i.e. its only
--            deviation is a leftover ended_at + `sessions close own`). Brings a
--            mid-state DB to the file without wiping:
--
--       drop policy if exists "sessions close own" on public.sessions;
--       revoke update on public.sessions from authenticated;   -- drops the ended_at/poll_hz grant
--       alter table public.sessions drop constraint if exists sessions_ended_at_sane;
--       alter table public.sessions drop column if exists ended_at;   -- cascades to the view
--       -- then recreate the view from schema.sql's final block (it no longer
--       -- selects s.ended_at as session_ended_at), e.g. copy the
--       -- `create view public.v_training_segments ...` statement verbatim.
--
--     After Path B, re-run this script; expect it clean.

-- ===========================================================================
-- 1. FORBIDDEN COLUMNS  — removed columns that must not exist anywhere
-- ===========================================================================
-- ended_at (dropped 2026-10-18), and the four columns removed on 2026-10-17
-- (merged_into / display_name / bot_mode / board_trajectory), and both consent
-- column names. EXPECT 0 ROWS. Any row here means the live DB predates a removal.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and column_name in (
    'ended_at', 'merged_into', 'display_name', 'bot_mode',
    'board_trajectory', 'consent_version', 'consented_at'
  )
order by table_name, column_name;

-- ===========================================================================
-- 2. POLICIES  — exactly five, and NONE for UPDATE or DELETE
-- ===========================================================================
-- 2a. Any UPDATE/DELETE policy is a deviation (the schema is strictly
--     append-only — the one-shot `sessions close own` was removed). EXPECT 0 ROWS.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and cmd in ('UPDATE', 'DELETE')
order by tablename, policyname;

-- 2b. The full policy set, to eyeball. EXPECT EXACTLY these five:
--       profiles        | profiles select own        | SELECT
--       segments        | segments insert own        | INSERT
--       session_metrics | session metrics select own | SELECT
--       sessions        | sessions insert own        | INSERT
--       sessions        | sessions select own        | SELECT
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- ===========================================================================
-- 3. FUNCTIONS  — the consent/merge machinery must be gone
-- ===========================================================================
-- 3a. These must NOT exist (removed with consent and merging). EXPECT 0 ROWS.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('current_consent_version', 'mirror_consent_to_subject', 'enforce_merge_depth')
order by proname;

-- 3b. These two MUST exist. EXPECT 2 ROWS (current_subject_id, handle_new_user).
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('current_subject_id', 'handle_new_user')
order by proname;

-- ===========================================================================
-- 4. DEFAULTS & CONSTRAINT VALIDATION
-- ===========================================================================
-- 4a. sampling_version default. EXPECT a single row showing '1'.
select column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sessions'
  and column_name = 'sampling_version';

-- 4b. Any CHECK constraint left NOT VALID is a deviation (the from-scratch file
--     validates all of them inline). EXPECT 0 ROWS.
select conrelid::regclass as table_name, conname
from pg_constraint
where connamespace = 'public'::regnamespace
  and contype = 'c'
  and not convalidated
order by 1, 2;

-- ===========================================================================
-- 5. RLS ENABLED  — on all six tables
-- ===========================================================================
-- Any listed table with RLS off is a deviation. EXPECT 0 ROWS.
select relname
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
  and relrowsecurity = false
  and relname in ('subjects', 'profiles', 'sessions', 'segments',
                  'session_metrics', 'archive_manifest')
order by relname;

-- ===========================================================================
-- 6. VIEW & archive_manifest  — renamed/removed columns
-- ===========================================================================
-- 6a. The view must NOT expose these (ended_at dropped, consent removed).
--     EXPECT 0 ROWS.
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'v_training_segments'
  and column_name in ('session_ended_at', 'subject_consent_version')
order by column_name;

-- 6b. archive_manifest must carry subject_id, not the old raw_subject_id.
--     EXPECT 0 ROWS.
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'archive_manifest'
  and column_name = 'raw_subject_id';

-- ===========================================================================
-- 7. CLIENT GRANTS  — the 42501 / append-only guard
-- ===========================================================================
-- 7a. authenticated must have NO update/delete grant on sessions. EXPECT 0 ROWS.
select privilege_type, column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'sessions'
  and grantee = 'authenticated'
  and privilege_type in ('UPDATE', 'DELETE')
order by privilege_type, column_name;

-- 7b. The exact INSERT-granted columns on sessions, to eyeball. EXPECT these 19
--     and no others: id, subject_id, routine, difficulty, routine_config,
--     planned_duration_ms, dpi, sens, cm_per_360, fov_deg, refresh_hz,
--     device_fingerprint, user_agent, platform, screen_width, screen_height,
--     device_pixel_ratio, app_version, sampling_version.
--     started_at / ended_at / poll_hz MUST NOT appear.
select column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'sessions'
  and grantee = 'authenticated'
  and privilege_type = 'INSERT'
order by column_name;

-- 7c. The exact INSERT-granted columns on segments, to eyeball. EXPECT these 17:
--     session_id, segment_index, started_at_ms, outcome, target_distance,
--     time_to_click_ms, dwell_ms, click_offset_x, click_offset_y, target_count,
--     targets, engaged_index, trajectory, input_events, frame_count,
--     event_count, duration_ms.   id / created_at MUST NOT appear.
select column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'segments'
  and grantee = 'authenticated'
  and privilege_type = 'INSERT'
order by column_name;

-- ===========================================================================
-- 8. FULL COLUMN DUMP  — eyeball each table against schema.sql
-- ===========================================================================
-- Not deviation-only; a reference listing. Compare the column sets to the
-- create table blocks in schema.sql. Watch especially for any EXTRA column not
-- in the file (an old column that a removal missed) or a MISSING expected one.
select table_name, ordinal_position, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('subjects', 'profiles', 'sessions', 'segments',
                     'session_metrics', 'archive_manifest')
order by table_name, ordinal_position;
