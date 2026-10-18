-- Aimprint telemetry schema — the authoritative definition.
--
-- PASTE THIS FILE AS ONE BUFFER — NEVER IN CHUNKS. Postgres runs a
-- multi-statement simple query as a single implicit transaction, so a failure
-- anywhere rolls the whole run back and no intermediate state is ever visible.
-- Split it up and that guarantee is gone. The sharpest edge is the
-- `drop trigger if exists on_auth_user_created` / `create trigger` pair further
-- down: a signup landing between them gets an auth.users row with NO subjects
-- and NO profiles row, after which the client resolves a null subject_id and
-- silently drops every telemetry row that account ever produces — permanently,
-- with no error anywhere. That drop also holds ACCESS EXCLUSIVE on auth.users
-- until the run commits, so signups block (they do not fail) for its duration;
-- prefer a low-traffic moment. The orphan-repair block below heals anyone who
-- slipped through an earlier run.
--
-- ===========================================================================
-- THIS FILE CREATES FROM SCRATCH. IT IS NOT A MIGRATION.
-- ===========================================================================
-- Every `create table` here is unconditional, and every constraint is declared
-- INLINE in the table that owns it. That is a deliberate change from the old
-- idempotent-migration form, which had accumulated ~250 lines of `add column if
-- not exists` duplicating the definition two lines above it, `drop column if
-- exists` for columns this file no longer creates, pre-emptive `drop view` /
-- `drop policy` statements that existed only to clear dependencies before a
-- column drop, and `do $$ if not exists (select 1 from pg_constraint …) $$`
-- wrappers around every constraint. All of it existed to migrate a database
-- with data in it. The data was wiped on 2026-10-18, so none of it is needed,
-- and its absence is what makes this file readable.
--
-- The cost: running this against a database that already has these tables
-- fails on the first `create table` with 42P07. That is intentional — a loud
-- failure instead of a silent half-migration. To start over, run the teardown
-- below FIRST. It is commented out so it cannot fire by accident.
--
--   -- TEARDOWN — destroys all collected telemetry. There is no undo.
--   delete from auth.users;                  -- cascades to profiles
--   drop table if exists
--     public.archive_manifest, public.session_metrics, public.segments,
--     public.sessions, public.profiles, public.subjects cascade;
--   -- `cascade` takes the view, every policy, every index, every constraint
--   -- and the triggers that live on these tables with them. Functions are
--   -- free-standing and survive, so the two retired ones go by hand:
--   drop function if exists public.current_consent_version();
--   drop function if exists public.mirror_consent_to_subject();
--
-- If this schema ever has to change with real data in it, write a dated
-- migration file for that change alone. Do not turn this one back into a
-- migration — that is how it reached 1,232 lines the first time.
--
-- ===========================================================================
-- Six tables:
--   subjects         — a pseudonymous person. Survives account deletion.
--   profiles         — the link between an auth.users account and a subject.
--                      Deleted with the account, which anonymises the telemetry.
--   sessions         — one timed run: one routine, one difficulty, one hardware
--                      configuration. Pointer lock only pauses it.
--   segments         — one span of play closing with an outcome. The unit the
--                      model consumes.
--   session_metrics  — derived aggregates, written offline with the service key.
--   archive_manifest — the index of the offline Parquet archive (STORAGE.md).
--
-- Plus v_training_segments, a view (not a table) that the offline pipeline
-- reads with the service key.
--
-- The split exists because hardware and settings are session-scoped, not
-- segment-scoped. Storing dpi/sens/refresh on every segment row would both
-- bloat the table and permit a session whose rows disagree about the DPI.
--
-- Legacy: v1 stored everything in one flat `telemetry_logs` table whose rows
-- carried no identity at all. It has been DROPPED. Do not reinstate a `revoke`
-- against it — `revoke` has no `if exists` form, so a revoke on a table that is
-- gone fails with 42P01 and rolls back this entire run.

-- ---------------------------------------------------------------------------
-- subjects
-- ---------------------------------------------------------------------------
-- The stable identity every session hangs off. Deliberately NOT auth.users:
-- deleting an account removes the profiles row that maps a person to their
-- subject_id, leaving the telemetry intact but no longer attributable.
--
-- `kind` is the authoritative human/synthetic label, and it lives here rather
-- than on a segment because a client can lie about a row but cannot change its
-- own subject. Synthetic data (a bot driven in a real browser) is kept out of
-- the human set by running it under a subject provisioned with the service key
-- as kind='synthetic' (kind_source='provisioned'), never by trusting a per-row
-- boolean the client controls.
--
-- `kind` is DEFAULT-DENY: a new signup is 'unknown', not 'human'. It used to
-- default to 'human', which meant every stranger who ever signed up entered the
-- training set as a verified human — encoding absence of information as a
-- positive claim, and failing in only one direction (a bot becoming a human,
-- never the reverse), which is the worst direction for a bot detector. Trust is
-- granted here the same way RLS grants it below: explicitly, never by default.
-- 'human' and 'synthetic' are set ONLY by a deliberate service-key write; see
-- the labelling runbook after this table.
--
-- Because the training view joins `kind` live rather than stamping it onto each
-- segment row, relabelling is RETROACTIVE: label a subject today and every
-- segment they ever recorded reclassifies with it. That is what makes post-hoc
-- manual labelling correct rather than a workaround.
--
-- There is NO merge mechanism and no `merged_into` column. One subject row is
-- one identity, full stop. If the same person turns up on two accounts, exclude
-- the extra account at labelling time; do not reconcile them here and do not
-- add a coalesce() collapse to the training view. This is safe because the
-- cohort is ~25 hand-recruited contributors labelled by email, so a duplicate
-- surfaces while labelling — NOT because the sign-in gate prevents duplicates
-- (it does not; one person can hold two emails).

create table public.subjects (
  subject_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Default-deny.
  kind text not null default 'unknown'
    constraint subjects_kind_allowed
    check (kind in ('human', 'synthetic', 'unknown')),

  -- How `kind` was decided, so a synthetic subject provisioned by hand is
  -- distinguishable from one that merely defaulted. 'default' is the trigger's
  -- value; flip to 'provisioned' (or 'reviewed') with the service key when you
  -- deliberately set kind.
  kind_source text not null default 'default'
    constraint subjects_kind_source_check
    check (kind_source in ('default', 'provisioned', 'reviewed')),

  -- Which batch this subject belongs to: 'bot_v1_linear', 'bot_v2_jitter',
  -- 'friends_batch_1'. SERVICE-WRITTEN. Lets a train/test split hold out a
  -- whole bot variant, and lets an error analysis name WHICH bot evaded
  -- detection rather than reporting one undifferentiated miss rate. Requires
  -- one subject per bot variant — two variants sharing an account are
  -- indistinguishable afterwards. Free text on purpose: a CHECK would need
  -- editing every time a variant is added, for tens of rows.
  cohort text,

  -- When `kind` was last deliberately set. Provenance paired with kind_source:
  -- 'what decided it' plus 'when'. NULL means never deliberately labelled.
  labeled_at timestamptz,

  -- A deliberate label must carry its provenance. Closes the footgun where a
  -- hand-written UPDATE sets `kind` but leaves kind_source at 'default', which
  -- reads as "this was never actually decided" and would be demoted back to
  -- 'unknown' by any later backfill — undoing a real decision with no error.
  --
  -- Declared inline and VALIDATED from row one. It used to be NOT VALID so the
  -- file stayed re-runnable against rows that predated it, which left a
  -- permanent manual `validate constraint` step hanging over the schema. On a
  -- table created empty there is nothing to grandfather, so that step is gone.
  constraint subjects_label_has_provenance
    check (kind = 'unknown' or kind_source <> 'default')
);

-- ---------------------------------------------------------------------------
-- Labelling a subject  (service key / SQL editor ONLY)
-- ---------------------------------------------------------------------------
-- There is no client path to `subjects.kind` and there must never be one — see
-- the RLS section below, where subjects gets no client policy of any kind.
-- Label by hand, here, in batches. All four columns move together or
-- subjects_label_has_provenance rejects the write.
--
-- Do NOT turn this into a security definer function in the `public` schema.
-- PostgREST auto-exposes every public function as POST /rest/v1/rpc/<name>;
-- Postgres grants EXECUTE to PUBLIC by default (unlike tables); and Supabase's
-- default privileges grant it to anon and authenticated on top. A definer
-- function writing `kind` would therefore be callable by anyone holding the
-- publishable key inlined into the Vite bundle. If ergonomics ever justify a
-- helper, put it in a separate schema PostgREST does not expose and make it
-- security invoker.
--
-- `returning` is not decoration: ZERO ROWS BACK MEANS NO EMAIL MATCHED AND
-- NOTHING WAS LABELLED. A typo'd address is otherwise a silent no-op.
--
-- Bot accounts — one subject per variant, so a split can hold one out:
--
--   update public.subjects sub
--      set kind='synthetic', kind_source='provisioned',
--          cohort='bot_v1_linear', labeled_at=now()
--     from public.profiles p
--     join auth.users u on u.id = p.user_id
--    where sub.subject_id = p.subject_id
--      and lower(u.email) = any (array[
--            'bot01@example.com',
--            'bot02@example.com'
--          ])
--   returning sub.subject_id, u.email, sub.kind, sub.cohort;
--
-- Trusted human contributors:
--
--   update public.subjects sub
--      set kind='human', kind_source='reviewed',
--          cohort='friends_batch_1', labeled_at=now()
--     from public.profiles p
--     join auth.users u on u.id = p.user_id
--    where sub.subject_id = p.subject_id
--      and lower(u.email) = any (array['friend@example.com'])
--   returning sub.subject_id, u.email, sub.kind, sub.cohort;
--
-- Current label state, for eyeballing what exists:
--
--   select kind, kind_source, cohort, count(*)
--     from public.subjects group by 1,2,3 order by 1,2,3;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- One row per signed-in account. Created by a trigger on auth.users, never by
-- the client, so a user cannot attach themselves to somebody else's subject.
--
-- The client can SELECT its own row and nothing more — there is no update
-- policy and no update grant. The two consent columns that used to live here
-- (and the `profiles update own` policy that existed solely to write them) were
-- removed with the consent system on 2026-10-18.

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  subject_id uuid not null unique references public.subjects(subject_id),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_subject uuid;
begin
  insert into public.subjects default values returning subject_id into new_subject;
  insert into public.profiles (user_id, subject_id) values (new.id, new_subject);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Repair any auth.users row that has no profile. The drop/create of the trigger
-- above has a window (it holds ACCESS EXCLUSIVE on auth.users, so a signup in
-- that window BLOCKS rather than fails, but a signup that slipped through an
-- earlier run on an older file would have no subjects and no profiles row) —
-- and from then on the client resolves a null subject_id and silently drops
-- every row that account ever produces. This heals it. Idempotent (a run with
-- no orphans is a no-op) and safe to leave here permanently; it mirrors
-- handle_new_user() exactly, so a repaired user lands at the same default-deny
-- kind='unknown', kind_source='default'. Confirm zero orphans afterwards with
-- queries/campaign.sql section 4a.
do $$
declare
  orphan record;
  new_subject uuid;
begin
  for orphan in
    select u.id from auth.users u
      left join public.profiles p on p.user_id = u.id
     where p.user_id is null
  loop
    insert into public.subjects default values returning subject_id into new_subject;
    insert into public.profiles (user_id, subject_id) values (orphan.id, new_subject);
  end loop;
end $$;

-- The subject of the caller. SECURITY DEFINER so the RLS policies below can
-- read profiles without granting the client select on it.
--
-- STABLE guarantees the value does not change within a statement; it does NOT
-- make Postgres evaluate it only once. Only IMMUTABLE functions are folded at
-- plan time, so a STABLE zero-argument function sitting inside a per-row
-- subplan is re-executed for every row — and in the segments insert policy it
-- ran TWICE per row, because that policy's EXISTS reads sessions, which
-- re-applies its own RLS. Every call parses the JWT claims and hits
-- profiles_pkey.
--
-- That is why each policy below calls it as `(select public.current_subject_id())`
-- rather than bare. The scalar-subquery form becomes an InitPlan the planner
-- evaluates exactly once per statement. Keep the wrapper.
create or replace function public.current_subject_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select subject_id from public.profiles where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- One timed run. A run is a fixed-length session the player chose (5/10/15 min);
-- pointer lock only pauses and resumes it, so one session spans many locks. A
-- routine is built fresh per session (game.js start()), so routine and
-- difficulty are genuinely session-scoped and belong here.
--
-- A row only exists for a run that passed SESSION_MIN_PLAY_MS (constants.js).
-- Below that threshold the client buffers the session row AND its segments in
-- memory and discards both, so an abandoned 10-second run leaves nothing here
-- at all. See the gate note in src/game.js — the two must be withheld together,
-- or segments would queue against a session id that never arrives and retry
-- 23503 forever.
--
-- The hardware block is not optional metadata. dx/dy are raw device counts, so
-- they are meaningless across users without dpi; frame cadence scales with
-- refresh_hz; event cadence scales with poll_hz. Without these three, a model
-- trained across users learns the hardware. cm_per_360 is the DPI-independent
-- ground truth and is stored rather than derived so a later change to
-- sensitivity.js cannot silently reinterpret old rows.

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(subject_id) on delete cascade,

  -- Server clock, never client-supplied: ordering matters for both fatigue
  -- effects and replay detection, and started_at is absent from the insert
  -- grant below, so it cannot be forged.
  --
  -- There is deliberately NO `ended_at`. It was dropped on 2026-10-18: nothing
  -- in scope consumes it. The completion verdict and every duration come from
  -- segment timing (max(started_at_ms + duration_ms)) and started_at, so a
  -- session's active-play span is always re-derivable from its segments. The
  -- only thing a stored ended_at added — wall-clock span INCLUDING pauses — is
  -- not a feature any model reads, and the pause structure a future model might
  -- want is not recorded anyway. Carrying it meant the schema's only UPDATE
  -- policy (a client write path into an otherwise append-only table); dropping
  -- it restores strict append-only. See the RLS section.
  started_at timestamptz not null default now(),

  routine text not null
    constraint sessions_routine_allowed
    -- Free text on the wire; a typo would mint a silent cohort that quietly
    -- splits the dataset. gridshot and switching stay in the allowlist: the
    -- code still exists (withheld from the UI, see routines/index.js) and
    -- reviving one must not need a schema change.
    check (routine in ('flick', 'gridshot', 'spidershot', 'strafing', 'switching')),
  difficulty text not null
    constraint sessions_difficulty_allowed
    check (difficulty in ('easy', 'medium', 'hard')),
  -- The resolved difficulty.js entry for this session, so a later retune of
  -- ROUTINE_CONFIG does not retroactively mislabel what was actually played.
  routine_config jsonb,

  -- The session length the player CHOSE, stamped at insert. Intent, not
  -- outcome: whether the run was actually finished is DERIVED OFFLINE, by
  -- comparing max(started_at_ms + duration_ms) across the session's segments
  -- against this. A run reaching >= 70% of it counts as completed
  -- (SESSION_COMPLETE_FRACTION in constants.js — keep the two in step).
  planned_duration_ms int,

  -- Sensitivity. See sensitivity.js — one value, two consumers. A zero or
  -- negative value would divide-by-zero or silently invert the cm_per_360
  -- derivation downstream.
  dpi int not null constraint sessions_dpi_positive check (dpi > 0),
  sens double precision not null constraint sessions_sens_positive check (sens > 0),
  cm_per_360 double precision,

  fov_deg double precision,
  -- A rolling client estimate off the render loop.
  refresh_hz double precision,
  -- The measured pointer polling rate: the MEDIAN inter-arrival gap across the
  -- run's input_events. DERIVED OFFLINE with the service key — the client never
  -- writes it (there is no update path), so it is null during live collection
  -- and filled before training. queries/campaign.sql section 5 derives it, and
  -- the archive job computes it for free since it already decodes every
  -- segment's input_events. Median, not mean — one backgrounded tab produces a
  -- single enormous gap that would drag a mean down by hundreds of Hz. The
  -- service key bypasses RLS but NOT sessions_poll_hz_sane below, which still
  -- guards the offline write.
  poll_hz double precision,

  -- Hardware/browser fingerprint. Coarse on purpose: enough to hold out a
  -- device and check whether a biometric model generalises across hardware,
  -- not enough to be a tracking identifier of its own.
  device_fingerprint text,
  user_agent text,
  platform text,
  screen_width int,
  screen_height int,
  device_pixel_ratio double precision,

  -- Stamp of the code that produced the session. Without it, a change to the
  -- sampler or to difficulty.js silently mixes incomparable rows into one set.
  app_version text not null default 'unknown',
  -- Mirrors SAMPLING_VERSION in src/constants.js. Reset to 1 on 2026-10-18
  -- along with the data wipe: there is no older data, so there is no version
  -- history to carry. The default covers a row inserted without the key; the
  -- client always sends it explicitly.
  sampling_version int not null default 1,

  -- Sanity bound on poll_hz. It is written offline with the service key, which
  -- bypasses RLS but NOT a CHECK, so this still rejects a garbage value.
  constraint sessions_poll_hz_sane check (
    poll_hz is null or (poll_hz > 0 and poll_hz <= 8000)
  )
);

-- ---------------------------------------------------------------------------
-- segments
-- ---------------------------------------------------------------------------
-- One row is one segment, not one mesh. Destructible routines close a segment
-- on a click (hit/miss) or a timeout; tracking routines close one every
-- TRACK_WINDOW_MS (track), and once more when the run is paused or ends.
-- A destructible attempt interrupted by a pause is DISCARDED, not written:
-- there is no honest outcome for it, and 'timeout' would fabricate a failure.
--
-- Both streams are stored COLUMNAR — parallel arrays keyed by field name, not
-- an array of per-sample objects. Roughly a third of the size (no repeated
-- keys) and it loads straight into numpy without a Python-level loop.
--
--   trajectory   {t, dx, dy, yaw, pitch, tx, ty, tz, on}  — one entry per
--                rendered frame. Carries the world state (target position,
--                crosshair-on-target), which only exists at render time.
--                tx/ty/tz are OMITTED for static-target routines (flick,
--                spidershot): the engaged target does not move within a
--                segment, so its position already lives in `targets` at
--                engaged_index. Only routines declaring `movesTargets`
--                (strafing, and the withheld switching) carry them.
--   input_events {t0, dt, dx, dy}  — one entry per raw pointer sample
--                (getCoalescedEvents), at native polling rate, DELTA-ENCODED
--                with t0 and every dt an integer number of TENTHS of a
--                millisecond and dt[0] = 0. Absolute ms is
--                (t0 + cumsum(dt)) / 10, with an INTEGER cumsum — a float
--                cumsum over hundreds of terms would drift. Carries sub-frame
--                timing, which render-cadence sampling destroys. Nullable: a
--                session may run without raw capture.
--
-- These are not interchangeable. trajectory without input_events loses the
-- biometric signal; input_events without trajectory loses tracking error.
--
-- There is no board_trajectory column. It recorded the per-frame paths of the
-- NON-engaged targets and only the withheld multi-target `switching` routine
-- ever wrote it, so every row had it NULL. Reviving switching means re-adding
-- the column, its shape guard, its lz4 line and its grant entry. It is NOT the
-- same thing as trajectory's tx/ty/tz, which is the ENGAGED target's path and
-- is still written by strafing.

create table public.segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,

  -- Position within the session. Warmup, fatigue and any sequence model need
  -- ordering, and created_at cannot supply it: inserts are fire-and-forget and
  -- can land out of order. Contiguous from 0 even across a pause, and even
  -- across the SESSION_MIN_PLAY_MS gate, which delays delivery without
  -- renumbering.
  segment_index int not null
    constraint segments_segment_index_nonneg check (segment_index >= 0),
  created_at timestamptz not null default now(),
  -- Milliseconds of ACTIVE PLAY from session start to segment start, from the
  -- same clock the frames use: it excludes paused time, so
  -- max(started_at_ms + duration_ms) over a session is directly comparable to
  -- sessions.planned_duration_ms — which is what makes the completion verdict
  -- derivable with no gap-detection heuristic.
  started_at_ms int,

  outcome text not null check (outcome in ('hit', 'miss', 'timeout', 'track')),

  -- Engaged target distance at segment end. Null for a timeout — the target is
  -- already gone; the per-frame positions still carry it.
  target_distance double precision,

  -- Click segments only (hit/miss); null on timeout and track. dwell_ms may
  -- also be null on a hit or miss when the crosshair never registered contact
  -- before the click, which is why only one direction is enforced below.
  time_to_click_ms int,
  dwell_ms int,
  click_offset_x double precision,
  click_offset_y double precision,

  -- Board layout at segment start: [{x, y, z, r}].
  target_count int not null
    constraint segments_target_count_positive check (target_count > 0),
  targets jsonb not null,
  -- Index into `targets` of the engaged target — the one aimTarget() returned
  -- and the one tx/ty/tz tracks. Without it the engaged target is only
  -- recoverable by matching coordinates, which breaks once two targets overlap.
  engaged_index int,

  trajectory jsonb not null,
  input_events jsonb,

  -- Lengths lifted out of the jsonb so segments can be filtered and sanity
  -- checked without parsing either blob.
  frame_count int not null
    constraint segments_frame_count_positive check (frame_count > 0),
  event_count int,
  -- Segment play-time, lifted out of the trajectory's last `t` so "how long was
  -- this segment" is a column query, not a blob parse. A segment never spans a
  -- pause (one closes at pause and a fresh one opens on resume), so this is
  -- uncontaminated. Whole-session active play, and the completion verdict, are
  -- derived offline (see sessions.planned_duration_ms).
  duration_ms int,

  constraint segments_session_order unique (session_id, segment_index),

  -- A non-click outcome can never carry click-derived fields. This is the
  -- constraint that stops a fabricated reaction time entering the training set.
  constraint segments_click_fields_match_outcome check (
    outcome in ('hit', 'miss')
    or (
      time_to_click_ms is null
      and dwell_ms is null
      and click_offset_x is null
      and click_offset_y is null
    )
  ),

  -- A null satisfies a Postgres CHECK (it fails only when the expression is
  -- false), so this leaves click-only fields untouched on non-click rows while
  -- still rejecting a negative one. AND short-circuits to false on any false
  -- operand, so one combined constraint rejects exactly what three separate
  -- ones would.
  constraint segments_durations_nonneg check (
    time_to_click_ms >= 0 and dwell_ms >= 0 and duration_ms >= 0
  ),

  -- Shape guards. Each row states a count AND separately carries the array it
  -- counts; these make the database reject a row where the two disagree, so an
  -- assembly bug in telemetry.js is caught at write time rather than surfacing
  -- months later as a malformed feature in the pipeline — against data that, by
  -- then, cannot be re-collected.
  --
  -- The `?` (key-exists) test is LOAD-BEARING: jsonb_array_length(null)
  -- returns null, and a null expression SATISFIES a CHECK, so a blob that is
  -- present but missing its key would pass a bare length comparison.
  -- `? 'dt'` / `? 't'` turns that into a hard failure.
  --
  -- input_events uses key 'dt' because the stream is delta-encoded:
  -- {t0, dt:[...], dx, dy} with dt[0]=0, so len(dt) == event_count exactly.
  -- The trajectory key stays 't'.
  --
  -- All four are declared inline and VALIDATED. They were NOT VALID in the old
  -- file only because the live table held pre-reset rows whose input_events was
  -- the old {t, dx, dy} shape, which this check rejects — the failure that
  -- rolled back a migration run with 23514. A table created empty has nothing
  -- to grandfather, so the whole NOT VALID / `validate constraint` dance is
  -- gone.
  constraint segments_targets_len_matches
    check (jsonb_array_length(targets) = target_count),
  constraint segments_trajectory_len_matches
    check (trajectory ? 't' and jsonb_array_length(trajectory -> 't') = frame_count),
  constraint segments_input_events_len_matches check (
    input_events is null
    or (input_events ? 'dt' and jsonb_array_length(input_events -> 'dt') = event_count)
  ),
  constraint segments_engaged_index_in_range check (
    engaged_index is null or (engaged_index >= 0 and engaged_index < target_count)
  )
);

-- TOAST compression for the two payload columns. Every one of these blobs is
-- far over the ~2 kB TOAST threshold, so all of them are compressed and pushed
-- out of line on every insert — which makes the compressor a per-insert CPU
-- cost paid by every concurrent writer. lz4 is markedly faster than the default
-- pglz at a comparable ratio on this shape of data (long runs of repetitive
-- numeric headers), so this is throughput, not disk.
--
-- Deliberately NOT `set storage external` — that would disable compression
-- entirely and roughly triple the disk these columns occupy.
--
-- Wrapped so a server built without lz4 degrades to a notice instead of
-- rolling back the entire run (the whole file is one transaction). Every
-- statement here shares ONE exception handler, so a single failing line rolls
-- back the whole block — the others would silently revert to pglz while
-- reporting only "lz4 unavailable". Keep this block to live columns only; a
-- line naming a dropped column would take both of these down with it.
do $$
begin
  alter table public.segments alter column trajectory   set compression lz4;
  alter table public.segments alter column input_events set compression lz4;
exception when others then
  raise notice 'lz4 compression unavailable (%), leaving default pglz', sqlerrm;
end $$;

-- Autovacuum tuning for the archive-and-prune staging model (see STORAGE.md).
-- On Free tier segments is a ROLLING BUFFER, not a growing table: archived rows
-- are DELETEd, and their dead space must be reclaimed and REUSED by new inserts
-- fast enough that the table plateaus near its high-water mark instead of
-- creeping past the 500 MB limit (a DELETE never returns pages to the OS; it
-- only makes them reusable by this same table). The payload bytes live in the
-- TOAST side table, so that is where the churn is and where the scale factor
-- has to be lowered — the default 0.2 would let a fifth of the table turn to
-- bloat before a vacuum. Harmless on Pro; it just vacuums a little more often.
alter table public.segments set (autovacuum_vacuum_scale_factor = 0.05);
alter table public.segments set (toast.autovacuum_vacuum_scale_factor = 0.05);

-- ---------------------------------------------------------------------------
-- session_metrics
-- ---------------------------------------------------------------------------
-- Derived per-session aggregates for skill/weakness profiling: written offline
-- by the Python pipeline with the service key, read by the player. Regenerable,
-- so it is safe to recompute wholesale. The open `metrics` blob absorbs new
-- measures without a migration; promote one to a column when you want to index
-- or sort on it.

create table public.session_metrics (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  computed_at timestamptz not null default now(),
  metrics_version int not null default 1,
  accuracy double precision,
  mean_time_to_click_ms double precision,
  mean_dwell_ms double precision,
  on_target_ratio double precision,
  metrics jsonb
);

-- ---------------------------------------------------------------------------
-- archive_manifest
-- ---------------------------------------------------------------------------
-- The index of the offline archive (see STORAGE.md and model/DESIGN.md). On
-- Free tier, segments is a rolling staging buffer: an offline job writes each
-- aged session's segments to Parquet (local drive + Supabase Storage), records
-- a row HERE, verifies it, then DELETEs those segments. This table is PERMANENT
-- and tiny — it outlives the pruning and is what lets the pipeline plan a pull
-- without reading the blobs: one row per archived session, with the checksum
-- that gated the delete.
--
-- It stores subject_id, NEVER a resolved label. kind and cohort are joined LIVE
-- from subjects at train time, so retroactive relabelling still works after a
-- session is archived (label a contributor today, every archived session of
-- theirs reclassifies). Freezing is_human here would destroy that.
--
-- Service-key only: RLS on, zero client policies. The client never reads or
-- writes it, exactly like the archive job's Storage bucket.
create table public.archive_manifest (
  session_id        uuid primary key references public.sessions(id) on delete cascade,
  subject_id        uuid not null references public.subjects(subject_id),
  routine           text not null,
  difficulty        text not null,
  sampling_version  int  not null,
  segment_count     int  not null,
  byte_size         bigint not null,
  -- Where the Parquet lives. storage_path is the Supabase Storage object key
  -- (durable copy); local_path is the working copy on the operator's drive and
  -- is nullable because it is machine-specific.
  storage_path      text not null,
  local_path        text,
  -- sha256 over the sorted (session_id, segment_index) pairs, computed from the
  -- written Parquet and asserted equal to the database before any DELETE. The
  -- hard gate that makes "archive then prune" safe for unregenerable data.
  content_sha256    text not null,
  archived_at       timestamptz not null default now(),
  -- Set when the staging rows are actually deleted. A manifest row with
  -- pruned_at set whose session again has live segments is a late outbox replay
  -- (IndexedDB can resurface days later) — re-archive, re-verify, re-prune.
  pruned_at         timestamptz
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The training pull is "every segment for these subjects, in order"; the app
-- reads "this subject's recent sessions".
--
-- There is deliberately NO index on segments.outcome, and reinstating one would
-- be a regression. `outcome` has four distinct values on what will be the
-- largest table here, so the planner will never choose it over a sequential
-- scan; and nothing queries it anyway — segments has no select policy at all,
-- and the training pull filters on routine and label, never outcome. It was
-- also actively harmful: Postgres appends the heap TID as an implicit btree
-- tiebreaker, so on an append-only table every insert of a given outcome lands
-- at the right edge of that key's range. Four values means four hot leaf pages
-- shared by every concurrent writer — buffer-content-lock contention that
-- scales with user count, paid on every insert, for a read that never happens.
--
-- There is also no separate (session_id, segment_index) index:
-- segments_session_order's unique constraint above already IS that index, and a
-- second one would add write overhead with no query it serves that the first
-- does not.

create index sessions_subject_started_idx
  on public.sessions (subject_id, started_at desc);
create index sessions_routine_difficulty_idx
  on public.sessions (routine, difficulty);
create index subjects_kind_idx
  on public.subjects (kind);
-- Incremental pulls ("every segment since the last fetch") and the archive
-- job's age selection both need to range-scan created_at. BRIN, not btree,
-- precisely because the table is append-only: created_at is perfectly
-- correlated with physical row order, which is the one case BRIN is built for.
-- It costs a few kB (a btree would be hundreds of MB) and, unlike a btree, adds
-- no hot right-edge leaf page for every concurrent writer to contend on — the
-- same contention that keeps segments_outcome_idx permanently unbuilt.
create index segments_created_at_brin
  on public.segments using brin (created_at);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Append-only for the client, with no exceptions: there is no UPDATE policy and
-- no DELETE policy on ANY table here. A behavioural reference set an account
-- holder can rewrite is not a reference set. Every correction, and every
-- service-written column (poll_hz, the labels, session_metrics), is made with
-- the service key, which bypasses RLS entirely.
--
-- anon has no privileges at all — writing requires a signed-in user whose
-- subject the row already belongs to.

alter table public.subjects         enable row level security;
alter table public.profiles         enable row level security;
alter table public.sessions         enable row level security;
alter table public.segments         enable row level security;
alter table public.session_metrics  enable row level security;
-- archive_manifest gets RLS on and NO policy of any kind: it is written and read
-- only with the service key by the offline archive job. RLS-on-no-policy denies
-- the client everything, which is the whole intent.
alter table public.archive_manifest enable row level security;

-- subjects: no client policy of any kind. `kind` in particular must stay
-- unwritable, or a synthetic run could relabel itself human. Model predictions
-- must never be written back into it either — ground truth is what a person
-- decided, and a retrain that consumes its predecessor's guesses amplifies its
-- own errors, silently, across every future retrain.

-- profiles: a user may read their own row. That is all — no update policy and
-- no update grant, so the row is immutable to the client. The revoke is a
-- tightening, not an oversight: it replaces the `profiles update own` policy
-- plus a two-column consent grant, both removed with the consent system.
create policy "profiles select own"
  on public.profiles for select to authenticated
  using (user_id = auth.uid());

revoke update on public.profiles from authenticated;

-- sessions: insert and read your own. No update policy — the row is immutable
-- to the client once inserted. `poll_hz is null` in the insert check stops a
-- client planting a value in a column that is only ever written offline with
-- the service key; without an update policy there would be no way to correct a
-- forged one.
create policy "sessions insert own"
  on public.sessions for insert to authenticated
  with check (
    subject_id = (select public.current_subject_id())
    and poll_hz is null
  );

create policy "sessions select own"
  on public.sessions for select to authenticated
  using (subject_id = (select public.current_subject_id()));

-- No UPDATE policy on sessions (it had one briefly — a single-shot close that
-- wrote ended_at/poll_hz — removed on 2026-10-18 with the ended_at column).
-- The revoke mirrors profiles: the client has no update path at all, and
-- poll_hz is filled offline with the service key, which does not need a grant.
revoke update on public.sessions from authenticated;

-- Column-level insert grant. RLS gates which ROWS you may insert, never which
-- COLUMNS — the insert policy above passes for any value of any column. So
-- started_at (server clock) and poll_hz (service-written, offline) would be
-- forgeable at insert despite their comments. Revoking table-level insert and
-- granting it per column is what actually confines the client. `id` IS granted:
-- the client mints the session uuid so a segment can be enqueued before the
-- row's insert resolves (see supabase.js); a collision merely raises 23505 and
-- leaks nothing.
--
-- HAZARD — read before adding any client-written session column: a column the
-- client sends but is NOT granted here fails the whole insert with 42501, which
-- outbox.js classifies as PERMANENT and drops. Add the column to BOTH the
-- payload (telemetry.js) and this grant, or every session silently vanishes.
-- Supabase grants insert to anon by default too, but anon has no insert policy,
-- so its inserts fail at RLS regardless; it is left untouched here.
revoke insert on public.sessions from authenticated;
grant insert (
  id, subject_id, routine, difficulty, routine_config, planned_duration_ms,
  dpi, sens, cm_per_360, fov_deg, refresh_hz,
  device_fingerprint, user_agent, platform, screen_width, screen_height,
  device_pixel_ratio, app_version, sampling_version
) on public.sessions to authenticated;

-- segments: insert into your own session only. Deliberately NO select policy —
-- trajectory and input_events are the raw material of the biometric template,
-- and a compromised account should not be able to download its own reference
-- data to replay it. Aggregates reach the player through session_metrics.
create policy "segments insert own"
  on public.segments for insert to authenticated
  with check (
    exists (
      select 1 from public.sessions s
      where s.id = session_id
        and s.subject_id = (select public.current_subject_id())
    )
  );

-- Column-level insert grant, same reasoning as sessions above. Excludes `id`
-- (random uuid default) and `created_at` (now() default), which the client must
-- never set — created_at in particular is the ordering the archive job and
-- incremental pulls depend on. The same 42501-drops-everything HAZARD applies:
-- a new client-written segment column must be added to this grant too.
revoke insert on public.segments from authenticated;
grant insert (
  session_id, segment_index, started_at_ms, outcome, target_distance,
  time_to_click_ms, dwell_ms, click_offset_x, click_offset_y,
  target_count, targets, engaged_index, trajectory, input_events,
  frame_count, event_count, duration_ms
) on public.segments to authenticated;

-- session_metrics: read your own. Writes are service-key only.
create policy "session metrics select own"
  on public.session_metrics for select to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where s.id = session_id
        and s.subject_id = (select public.current_subject_id())
    )
  );

-- ---------------------------------------------------------------------------
-- Training view
-- ---------------------------------------------------------------------------
-- What fetch_telemetry.py should select, so the pipeline never has to join by
-- hand or re-derive the label. `is_human` comes from subjects.kind, which the
-- client cannot write — unlike the v1 per-row boolean, which it could.
-- Service-key reads bypass RLS, so this stays invisible to the browser.
--
-- `is_human` IS THREE-VALUED: true (confirmed human), false (confirmed
-- synthetic), NULL (nobody has labelled this subject). NULL is the default
-- state of every public signup and MUST be filtered out before fitting —
-- never coerced or imputed. A boolean CLI flag cannot express that filter, so
-- the pipeline needs a three-state option.
--
-- security_invoker so the view runs with the caller's privileges, not the
-- owner's. The real protection is the revoke below (only the service key, which
-- bypasses RLS, can read it); security_invoker removes the footgun where a
-- single future GRANT would otherwise expose every subject's trajectories
-- through an owner-privileged view.
--
-- subject_id is the grouping key for a train/test split (GroupKFold). One
-- subject row is one identity, so there is no merge or collapse step.
--
-- CONSUMING THIS VIEW (notes for fetch_telemetry.py):
--  * Filter the label with `where subject_kind in ('human','synthetic')`, NOT
--    `where is_human is not null`. is_human is a CASE expression, so the latter
--    is non-sargable: the planner falls back to 0.5 default selectivity and
--    full-scans segments plus its entire TOAST table. subject_kind is a plain
--    column and the filter is sargable.
--  * Page with KEYSET, never LIMIT/OFFSET. The view has no intrinsic order, so
--    OFFSET both skips and duplicates rows (and is O(n^2)). Order by
--    (segment_created_at, segment_id) and page on the last-seen pair.
--  * Incremental pulls ("since last watermark") must LAG, e.g.
--    `segment_created_at < now() - interval '1 hour'`: a row can commit after
--    your snapshot with an earlier created_at and be missed otherwise.
--  * AFTER ARCHIVAL this view is no longer the whole training set — it is only
--    the UN-ARCHIVED TAIL still in segments. The full dataset is
--    archive_manifest (joined to subjects for the live label) PLUS this tail.
--    See STORAGE.md and model/DESIGN.md.

create view public.v_training_segments
with (security_invoker = true) as
select
  g.id                              as segment_id,
  s.id                              as session_id,
  sub.subject_id,
  -- THREE-VALUED, and deliberately nullable. `sub.kind = 'human'` returned
  -- false for a confirmed synthetic subject AND for an unlabelled stranger,
  -- collapsing "measured non-human" and "nobody has checked" into one value
  -- and feeding the second into training as ground truth. NULL now means "no
  -- label" and MUST be filtered out before fitting, never coerced.
  case sub.kind
    when 'human'     then true
    when 'synthetic' then false
    else null
  end                               as is_human,
  sub.kind                          as subject_kind,
  -- Provenance. subjects_label_has_provenance is validated, so
  -- `is_human is not null` already implies a deliberate label; these are
  -- audit-grade rather than load-bearing.
  sub.kind_source                   as subject_kind_source,
  sub.cohort                        as subject_cohort,
  sub.labeled_at                    as subject_labeled_at,
  s.routine,
  s.difficulty,
  s.planned_duration_ms,
  s.routine_config,
  s.dpi,
  s.sens,
  s.cm_per_360,
  s.fov_deg,
  s.refresh_hz,
  s.poll_hz,
  s.device_fingerprint,
  s.app_version,
  s.sampling_version,
  s.started_at        as session_started_at,
  g.segment_index,
  -- Insert time. The keyset-pagination and incremental-pull cursor; see header.
  g.created_at        as segment_created_at,
  g.started_at_ms,
  g.outcome,
  g.target_distance,
  g.time_to_click_ms,
  g.dwell_ms,
  g.click_offset_x,
  g.click_offset_y,
  g.target_count,
  g.targets,
  g.engaged_index,
  g.trajectory,
  g.input_events,
  g.frame_count,
  g.event_count,
  g.duration_ms
from public.segments g
join public.sessions s   on s.id = g.session_id
join public.subjects sub on sub.subject_id = s.subject_id;

revoke all on public.v_training_segments from anon, authenticated;
