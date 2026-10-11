-- Aim Trainer telemetry schema (v2 — multi-user).
-- Run this in the Supabase SQL editor (or psql) before starting a session.
--
-- PASTE THIS FILE AS ONE BUFFER — NEVER IN CHUNKS. Postgres runs a
-- multi-statement simple query as a single implicit transaction, so a failure
-- anywhere rolls the whole run back and no intermediate state is ever visible.
-- Split it up and that guarantee is gone. The sharpest edge is the
-- `drop trigger if exists on_auth_user_created` / `create trigger` pair further
-- down: a signup landing between them gets an auth.users row with NO subjects
-- and NO profiles row, after which the client resolves a null subject_id and
-- silently drops every telemetry row that account ever produces — permanently,
-- with no error anywhere. Nothing in this file repairs such a user. That drop
-- also holds ACCESS EXCLUSIVE on auth.users until the run commits, so signups
-- block (they do not fail) for its duration; prefer a low-traffic moment.
-- Afterwards, confirm none were stranded:
--   select u.id, u.email, u.created_at from auth.users u
--     left join public.profiles p on p.user_id = u.id
--    where p.user_id is null;   -- expect zero rows
--
-- Five tables:
--   subjects        — a pseudonymous person. Survives account deletion.
--   profiles        — the link between an auth.users account and a subject.
--                     Deleted with the account, which anonymises the telemetry.
--   sessions        — one timed run: one routine, one difficulty, one hardware
--                     configuration. Pointer lock only pauses it.
--   segments        — one span of play closing with an outcome. The unit the
--                     model consumes.
--   session_metrics — derived aggregates, written offline with the service key.
--
-- Plus v_training_segments, a view (not a table) that the offline pipeline
-- reads with the service key.
--
-- The split exists because hardware and settings are session-scoped, not
-- segment-scoped. Storing dpi/sens/refresh on every segment row would both
-- bloat the table and permit a session whose rows disagree about the DPI.

-- ---------------------------------------------------------------------------
-- Legacy — nothing to do here any more
-- ---------------------------------------------------------------------------
-- v1 stored everything in one flat `telemetry_logs` table whose rows carried no
-- identity at all, so they could never be attached to a subject or mixed into a
-- multi-user training set. That table was renamed `telemetry_logs_v1`, kept as a
-- graveyard for a while, and has since been DROPPED by hand.
--
-- This file therefore no longer renames it or revokes on it. Do not reinstate
-- either statement: `revoke` has no `if exists` form, so a revoke against a
-- table that is gone fails with 42P01 and — because the whole file runs as one
-- implicit transaction — rolls back every other change in the run.

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
-- the labelling runbook after the constraints.
--
-- Because the training view joins `kind` live rather than stamping it onto each
-- segment row, relabelling is RETROACTIVE: label a subject today and every
-- segment they ever recorded reclassifies with it. That is what makes post-hoc
-- manual labelling correct rather than a workaround.

create table if not exists public.subjects (
  subject_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Default-deny. The constraint is NAMED, unlike the original inline one,
  -- whose auto-generated name is why the migration below has to discover it by
  -- the column it constrains instead of by name.
  kind text not null default 'unknown'
    constraint subjects_kind_allowed
    check (kind in ('human', 'synthetic', 'unknown')),

  -- Consent is stamped here, not only on profiles, so the record of it survives
  -- account deletion along with the data it authorises.
  consent_version text,
  consented_at timestamptz,

  -- Deduplication. One human can land on more than one subject — a second
  -- browser, cleared storage, a new device each mints a fresh auth user and so
  -- a fresh subject via the trigger below. Point the duplicates at the survivor
  -- here (never merge the rows: append-only), and the training view collapses
  -- them to one identity. NULL means "this row is itself canonical". Left unset
  -- the ML grouping key (subject_id) would leak the same person across a
  -- train/test split and silently inflate accuracy.
  merged_into uuid references public.subjects(subject_id),

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
  labeled_at timestamptz
);

-- Additive migration for databases created before these columns existed.
-- `create table if not exists` above is a no-op on an existing table, so the
-- columns have to be added explicitly for a re-run to upgrade in place.
alter table public.subjects
  add column if not exists merged_into uuid references public.subjects(subject_id);
alter table public.subjects
  add column if not exists kind_source text not null default 'default';
-- These two are what actually upgrade a live database; the create table above
-- is a no-op there. Not redundant with the canonical definition: the training
-- view references sub.cohort, so omitting these fails loudly at view creation
-- and rolls the whole run back rather than producing a half-migrated schema.
alter table public.subjects add column if not exists cohort text;
alter table public.subjects add column if not exists labeled_at timestamptz;
-- The check constraint is added separately so a re-run does not error if it is
-- already present (Postgres has no "add constraint if not exists").
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.subjects'::regclass
       and conname = 'subjects_kind_source_check'
  ) then
    alter table public.subjects
      add constraint subjects_kind_source_check
      check (kind_source in ('default', 'provisioned', 'reviewed'));
  end if;
end $$;

-- Widen `kind` to three values. The original check was written inline and
-- UNNAMED, so Postgres auto-generated its name ('subjects_kind_check', or with
-- a digit appended if that was ever taken) — which is why it is discovered by
-- conkey (the column the expression touches) rather than by name. A by-name
-- drop that missed would leave the old two-value constraint ANDed with the new
-- one, so 'unknown' would stay rejected, and because SET DEFAULT below is not
-- validated against CHECK constraints nothing would reveal it until signup
-- broke. subjects_kind_source_check has a different conkey and is untouched;
-- subjects_label_has_provenance spans two columns and is likewise unmatched.
--
-- contype = 'c' is load-bearing, not decorative: on PG18 NOT NULL constraints
-- are catalogued in pg_constraint too, with the same conkey as this column.
--
-- Names are collected before the loop rather than dropped from under an open
-- cursor over pg_constraint.
do $$
declare
  doomed text[];
  victim text;
begin
  select coalesce(array_agg(con.conname), '{}')
    into doomed
    from pg_constraint con
   where con.conrelid = 'public.subjects'::regclass
     and con.contype = 'c'
     and con.conname <> 'subjects_kind_allowed'
     and con.conkey = array(
           select attnum from pg_attribute
            where attrelid = 'public.subjects'::regclass and attname = 'kind');

  foreach victim in array doomed loop
    execute format('alter table public.subjects drop constraint %I', victim);
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.subjects'::regclass
       and conname = 'subjects_kind_allowed'
  ) then
    alter table public.subjects
      add constraint subjects_kind_allowed
      check (kind in ('human', 'synthetic', 'unknown'));
  end if;
end $$;

-- Default-deny. MUST run AFTER the constraint above accepts 'unknown'.
-- SET DEFAULT is not validated against CHECK constraints at ALTER time — it
-- only coerces the expression to the column type and writes pg_attrdef, with
-- no constraint evaluation and no row scan. Run it first and nothing looks
-- wrong until the next signup: handle_new_user()'s `insert ... default values`
-- supplies 'unknown', the old CHECK rejects it, the exception escapes the
-- security definer trigger, and the insert into auth.users ABORTS — GoTrue
-- returns 500 and signup is broken for every new user, with a schema file that
-- reads perfectly correct. Idempotent; does not rewrite existing rows.
alter table public.subjects alter column kind set default 'unknown';

-- A deliberate label must carry its provenance. Closes the one residual
-- footgun: a hand-written UPDATE that sets `kind` but leaves kind_source at
-- 'default', which the backfill's predicate would later silently demote back
-- to 'unknown' — undoing a real decision with no error.
--
-- NOT VALID is load-bearing: it enforces on every future insert and update but
-- skips the scan of existing rows, so this file stays re-runnable against a
-- database where the one-time backfill has not been applied yet. Promote it by
-- hand once, after that backfill:
--   alter table public.subjects validate constraint subjects_label_has_provenance;
-- A FRESH database has no rows to backfill and should run that validate
-- immediately, or the constraint stays permanently unvalidated.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.subjects'::regclass
       and conname = 'subjects_label_has_provenance'
  ) then
    alter table public.subjects
      add constraint subjects_label_has_provenance
      check (kind = 'unknown' or kind_source <> 'default') not valid;
  end if;
end $$;

-- merged_into integrity. The training view collapses a subject onto its
-- survivor with coalesce(merged_into, subject_id), which resolves EXACTLY ONE
-- level: with A->B and B->C, A collapses to B but C stays separate, so one
-- person lands on both sides of a GroupKFold split. For the bot detector that
-- silently inflates accuracy; for biometric identification it is fatal, since
-- telling people apart IS the task. These two guards pin the chain depth at 1.
--
-- Self-reference is a plain CHECK (a subject cannot be its own survivor).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.subjects'::regclass
       and conname = 'subjects_merged_into_not_self'
  ) then
    alter table public.subjects
      add constraint subjects_merged_into_not_self
      check (merged_into is distinct from subject_id);
  end if;
end $$;

-- Chain and fan-in need a trigger, because a CHECK cannot read other rows. It
-- rejects (a) pointing at a subject that is itself already merged, and (b)
-- merging a subject that is already somebody else's survivor — together that is
-- depth <= 1 in both directions, which is exactly what the view's one-level
-- coalesce assumes. SECURITY DEFINER with an empty search_path (every reference
-- is schema-qualified; pg_catalog is always implicitly searched).
create or replace function public.enforce_merge_depth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.merged_into is null then
    return new;
  end if;

  -- (a) the survivor must itself be canonical.
  if exists (
    select 1 from public.subjects
     where subject_id = new.merged_into
       and merged_into is not null
  ) then
    raise exception
      'cannot merge % into %, which is itself merged (no merge chains)',
      new.subject_id, new.merged_into;
  end if;

  -- (b) this subject must not already be a survivor others point at.
  if exists (
    select 1 from public.subjects
     where merged_into = new.subject_id
  ) then
    raise exception
      'cannot merge %, which is already the survivor of another subject',
      new.subject_id;
  end if;

  return new;
end;
$$;

drop trigger if exists subjects_enforce_merge_depth on public.subjects;

create trigger subjects_enforce_merge_depth
  before insert or update of merged_into on public.subjects
  for each row execute function public.enforce_merge_depth();

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
--
-- After labelling, confirm no canonical identity carries divergent labels. The
-- view collapses subject_id through merged_into but reads `kind` off the RAW
-- row, so labelling one of a person's duplicate accounts and missing the other
-- makes half their segments emit NULL and be dropped by the pipeline's filter —
-- data loss for a subject you did label, with no error. Expect zero rows:
--
--   select coalesce(sub.merged_into, sub.subject_id) as canonical
--     from public.subjects sub group by 1
--    having count(distinct sub.kind) > 1
--        or count(distinct coalesce(sub.cohort,'')) > 1;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- One row per signed-in account. Created by a trigger on auth.users, never by
-- the client, so a user cannot attach themselves to somebody else's subject.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  subject_id uuid not null unique references public.subjects(subject_id),
  created_at timestamptz not null default now(),
  display_name text,
  consent_version text,
  consented_at timestamptz
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
-- earlier run on an older file would have no subjects and no profiles row) — and
-- from then on the client resolves a null subject_id and silently drops every
-- row that account ever produces. This heals it. Idempotent (a run with no
-- orphans is a no-op) and safe to leave in the file permanently; it mirrors
-- handle_new_user() exactly, so a repaired user lands at the same default-deny
-- kind='unknown', kind_source='default'. Confirm zero orphans with the query in
-- this file's header after every run.
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
-- evaluates exactly once per statement, which is what the old comment here
-- incorrectly claimed STABLE alone was doing. Keep the wrapper.
create or replace function public.current_subject_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select subject_id from public.profiles where user_id = auth.uid();
$$;

-- The consent version of the caller, or null if they have never consented. Same
-- SECURITY DEFINER / empty-search_path / scalar-subquery discipline as
-- current_subject_id(): the sessions insert policy calls it to refuse telemetry
-- from an unconsented account AT THE DATABASE, not only in the client, where
-- canPlay() / applyStartGate() already gate it. Deliberately returns the version
-- rather than a boolean so the policy can test for existence; it compares
-- against NULL, never against a specific version, because the database has no
-- business knowing CONSENT_VERSION — currency stays a client concern (a bumped
-- version re-prompts in the client), while the EXISTENCE of consent becomes an
-- unconditional server-side precondition for writing biometric data.
create or replace function public.current_consent_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select consent_version from public.profiles where user_id = auth.uid();
$$;

-- Consent durability. profiles.consent_version is where the client writes (it
-- is the only column pair the grant below permits), but profiles is
-- `on delete cascade` from auth.users — so deleting an account destroys the
-- only record that consent was ever given, while the sessions and segments it
-- authorised survive on the subject. subjects.consent_version exists precisely
-- to outlive that deletion, and until this trigger it was never written by
-- anything: the guarantee in the subjects comment above was aspirational.
--
-- SECURITY DEFINER because the client has no policy on subjects and must not
-- get one. This writes ONLY the two consent columns — never `kind` — so the
-- default-deny label contract is untouched. The client still cannot influence
-- anything here beyond consenting for its own profile, which is the intended
-- action.
create or replace function public.mirror_consent_to_subject()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.consent_version is not null
     and (new.consent_version, new.consented_at)
         is distinct from (old.consent_version, old.consented_at) then
    update public.subjects
       set consent_version = new.consent_version,
           consented_at    = new.consented_at
     where subject_id = new.subject_id;
  end if;
  return new;
end;
$$;

-- AFTER UPDATE only. Consent is never present at INSERT — handle_new_user()
-- writes just (user_id, subject_id) — and referencing OLD in an INSERT trigger
-- would raise.
drop trigger if exists profiles_mirror_consent on public.profiles;

create trigger profiles_mirror_consent
  after update on public.profiles
  for each row execute function public.mirror_consent_to_subject();

-- One-time backfill for accounts that consented before the trigger existed.
-- Idempotent: the `is distinct from` makes a re-run a no-op.
update public.subjects sub
   set consent_version = p.consent_version,
       consented_at    = p.consented_at
  from public.profiles p
 where p.subject_id = sub.subject_id
   and p.consent_version is not null
   and sub.consent_version is distinct from p.consent_version;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- One timed run. A run is a fixed-length session the player chose (5/10/15 min);
-- pointer lock only pauses and resumes it, so one session spans many locks. A
-- routine is built fresh per session (game.js start()), so routine and
-- difficulty are genuinely session-scoped and belong here.
--
-- The hardware block is not optional metadata. dx/dy are raw device counts, so
-- they are meaningless across users without dpi; frame cadence scales with
-- refresh_hz; event cadence scales with poll_hz. Without these three, a model
-- trained across users learns the hardware. cm_per_360 is the DPI-independent
-- ground truth and is stored rather than derived so a later change to
-- sensitivity.js cannot silently reinterpret old rows.

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(subject_id) on delete cascade,

  -- Server clock. Never client-supplied: a client-set timestamp is forgeable,
  -- and ordering matters for both fatigue effects and replay detection.
  started_at timestamptz not null default now(),
  -- SERVICE-WRITTEN, never by the client. The session row is inserted at
  -- game.start(), when the end is by definition unknown, and there is no update
  -- policy (append-only, by design), so the client cannot close it later. It is
  -- filled offline from started_at + the last segment's (started_at_ms +
  -- trajectory tail) — a server-anchored, monotonic figure, more trustworthy
  -- than a forgeable client wall-clock. Do NOT "fix" this with an update policy.
  --
  -- Since sampling_version 3 that clock EXCLUDES paused time, so this is the end
  -- of active play, not wall-clock end. A deliberate redefinition: active play
  -- is the comparable figure, and wall-clock end is not recoverable (pause
  -- spans are not recorded).
  ended_at timestamptz,

  routine text not null,
  difficulty text not null,
  -- The resolved difficulty.js entry for this session, so a later retune of
  -- ROUTINE_CONFIG does not retroactively mislabel what was actually played.
  routine_config jsonb,

  -- The session length the player CHOSE, stamped at insert. Intent, not outcome:
  -- the client can only write this row at start (no update policy — see
  -- ended_at), so whether the run was actually finished is DERIVED OFFLINE, by
  -- comparing max(started_at_ms + duration_ms) across the session's segments
  -- against this. A run reaching >= 70% of it counts as completed
  -- (SESSION_COMPLETE_FRACTION in constants.js — keep the two in step).
  -- NULL on rows written before timed sessions shipped, which is how you filter
  -- them out of a completion cohort.
  planned_duration_ms int,

  -- Sensitivity. See sensitivity.js — one value, two consumers.
  dpi int not null,
  sens double precision not null,
  cm_per_360 double precision,

  -- Rendering and input rates. refresh_hz is a rolling client estimate off the
  -- render loop. poll_hz is SERVICE-WRITTEN: the client leaves it null and it is
  -- derived offline from input_events inter-arrival gaps, which measure the true
  -- pointer polling rate more accurately than anything the page can sample.
  fov_deg double precision,
  refresh_hz double precision,
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

  -- LEGACY. The in-browser Bot Mode was removed, so the client no longer writes
  -- this and it is always null on new rows. Kept as a column so old rows still
  -- parse. Synthetic data is now produced only under a subject explicitly
  -- flagged kind='synthetic' (kind_source='provisioned'); the label lives on the
  -- subject, never on a client-controlled per-session field.
  bot_mode text,

  -- Stamp of the code that produced the session. Without it, a change to the
  -- sampler or to difficulty.js silently mixes incomparable rows into one set.
  app_version text not null default 'unknown',
  sampling_version int not null default 4
);

-- Additive migration for databases created before timed sessions shipped.
-- `create table if not exists` above is a no-op on an existing table, so the
-- column has to be added explicitly for a re-run to upgrade in place.
alter table public.sessions add column if not exists planned_duration_ms int;

-- The default means "what this deployment's client produces", now 4 (the client
-- always sends it explicitly, so this only covers a row inserted without the key;
-- leaving it at 3 would mislabel such a row as pre-shrink v3 data). Idempotent,
-- and it does not rewrite existing rows — old v3 rows keep sampling_version 3.
alter table public.sessions alter column sampling_version set default 4;

-- dpi/sens feed sensitivity.js's cm_per_360 derivation directly; a zero or
-- negative value would divide-by-zero or silently invert it downstream.
-- Scoped by conrelid as well as conname; see the note on the segments guards
-- below for why a name-only check is unsafe.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sessions'::regclass
                    and conname = 'sessions_dpi_positive') then
    alter table public.sessions add constraint sessions_dpi_positive check (dpi > 0);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sessions'::regclass
                    and conname = 'sessions_sens_positive') then
    alter table public.sessions add constraint sessions_sens_positive check (sens > 0);
  end if;
  -- routine/difficulty are free text on the wire; a typo would mint a silent
  -- cohort that quietly splits the dataset. gridshot and switching stay in the
  -- allowlist: the code still exists (withheld from the UI, see routines/index.js)
  -- and any pre-existing rows must still validate.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sessions'::regclass
                    and conname = 'sessions_routine_allowed') then
    alter table public.sessions add constraint sessions_routine_allowed
      check (routine in ('flick', 'gridshot', 'spidershot', 'strafing', 'switching'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sessions'::regclass
                    and conname = 'sessions_difficulty_allowed') then
    alter table public.sessions add constraint sessions_difficulty_allowed
      check (difficulty in ('easy', 'medium', 'hard'));
  end if;
end $$;

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
--   input_events {t, dx, dy}                              — one entry per raw
--                pointer sample (getCoalescedEvents), at native polling rate.
--                Carries sub-frame timing, which render-cadence sampling
--                destroys. Nullable: a session may run without raw capture.
--
-- These are not interchangeable. trajectory without input_events loses the
-- biometric signal; input_events without trajectory loses tracking error.

create table if not exists public.segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,

  -- Position within the session. Warmup, fatigue and any sequence model need
  -- ordering, and created_at cannot supply it: inserts are fire-and-forget and
  -- can land out of order.
  segment_index int not null,
  created_at timestamptz not null default now(),
  -- Milliseconds of ACTIVE PLAY from session start to segment start, from the
  -- same clock the frames use. Since sampling_version 3 that clock excludes
  -- paused time, so max(started_at_ms + duration_ms) over a session is directly
  -- comparable to sessions.planned_duration_ms — which is what makes the
  -- completion verdict derivable with no gap-detection heuristic.
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
  target_count int not null,
  targets jsonb not null,
  -- Index into `targets` of the engaged target — the one aimTarget() returned
  -- and the one tx/ty/tz tracks. Without it the engaged target is only
  -- recoverable by matching coordinates, which breaks once two targets overlap.
  engaged_index int,

  trajectory jsonb not null,
  input_events jsonb,

  -- The paths of the NON-engaged targets, per rendered frame, for a routine
  -- that holds several MOVING targets at once (switching). trajectory only
  -- carries the engaged target's tx/ty/tz, so without this the other targets'
  -- motion is unrecoverable — and "how far was the next target, did they switch
  -- to the nearest" is exactly the signal that routine exists to measure. NULL
  -- for single-target and static routines (flick, gridshot, spidershot,
  -- strafing), where `targets` at segment start already describes the board.
  -- Columnar and aligned to `targets`: {x: [[per-frame] per target], y, z}.
  board_trajectory jsonb,

  -- Lengths lifted out of the jsonb so segments can be filtered and sanity
  -- checked without parsing either blob.
  frame_count int not null,
  event_count int,
  -- Segment play-time, lifted out of the trajectory's last `t` so "how long was
  -- this segment" is a column query, not a blob parse. A segment never spans a
  -- pause (one closes at pause and a fresh one opens on resume), so this is
  -- uncontaminated. Whole-session active play, and the completion verdict, are
  -- derived offline (see sessions.ended_at and sessions.planned_duration_ms).
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
  )
);

-- Additive migration for databases created before these columns existed.
alter table public.segments add column if not exists board_trajectory jsonb;
alter table public.segments add column if not exists duration_ms int;

-- Sanity bounds on fields the model reads directly. None of these should ever
-- be violated by the client as it stands today; they exist so a bug (or a
-- request crafted by hand against the REST API) can't quietly seed the
-- training set with a negative duration or a zero-frame segment instead of
-- being rejected at write time. A null still satisfies each of these (Postgres
-- CHECK is satisfied unless the expression is false), so click-only fields
-- stay untouched on non-click rows.
-- Each guard is scoped by conrelid as well as conname. Constraint names are
-- only unique per TABLE in Postgres, not per schema, so a name-only check would
-- silently skip adding a constraint here because an unrelated table already
-- carries one by that name — leaving the column unguarded with no error.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_frame_count_positive') then
    alter table public.segments add constraint segments_frame_count_positive check (frame_count > 0);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_target_count_positive') then
    alter table public.segments add constraint segments_target_count_positive check (target_count > 0);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_segment_index_nonneg') then
    alter table public.segments add constraint segments_segment_index_nonneg check (segment_index >= 0);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_durations_nonneg') then
    alter table public.segments add constraint segments_durations_nonneg
      check (time_to_click_ms >= 0 and dwell_ms >= 0 and duration_ms >= 0);
  end if;
end $$;

-- Shape guards. Each row states a count AND separately carries the array it
-- counts; these make the database reject a row where the two disagree, so an
-- assembly bug in telemetry.js is caught at write time rather than surfacing
-- months later as a malformed feature in the pipeline — against data that, by
-- then, cannot be re-collected.
--
-- The `?` (key-exists) test is LOAD-BEARING: jsonb_array_length(null) returns
-- null, and a null expression SATISFIES a CHECK (a check fails only when it is
-- false), so a blob that is present but missing its key would pass a bare
-- length comparison. `? 'dt'`/`? 't'` turns that into a hard failure.
--
-- input_events uses key 'dt' because sampling_version 4 delta-encodes it:
-- {t0, dt:[...], dx, dy} with dt[0]=0, so len(dt) == event_count exactly. The
-- trajectory key stays 't'. board_trajectory is {x,y,z} of per-target arrays,
-- so its outer length is target_count.
--
-- ALL FIVE are NOT VALID, and that is load-bearing, not a convenience. The
-- table is NOT empty: a live database may already hold pre-v4 rows whose
-- input_events is the OLD shape ({t, dx, dy} — absolute t, no 'dt' key), which
-- the input_events check rejects. NOT VALID enforces the shape on every future
-- INSERT/UPDATE (which are all v4 and conform) while skipping the scan of
-- existing rows — so the migration does not fail on history, and the append-only
-- v3 rows are grandfathered. They are excluded from a v4 training pull by
-- sampling_version and will be pruned anyway, so there is nothing to gain from
-- validating against them. Do NOT `validate constraint` these while any pre-v4
-- row remains; it would scan every row and TOASTed blob under ACCESS EXCLUSIVE
-- and fail on the old input_events shape. A genuinely fresh (empty) database
-- loses nothing by their being NOT VALID — there are no rows to validate.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_targets_len_matches') then
    alter table public.segments add constraint segments_targets_len_matches
      check (jsonb_array_length(targets) = target_count) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_trajectory_len_matches') then
    alter table public.segments add constraint segments_trajectory_len_matches
      check (trajectory ? 't' and jsonb_array_length(trajectory -> 't') = frame_count) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_input_events_len_matches') then
    alter table public.segments add constraint segments_input_events_len_matches
      check (
        input_events is null
        or (input_events ? 'dt' and jsonb_array_length(input_events -> 'dt') = event_count)
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_board_trajectory_len_matches') then
    alter table public.segments add constraint segments_board_trajectory_len_matches
      check (
        board_trajectory is null
        or jsonb_array_length(board_trajectory -> 'x') = target_count
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.segments'::regclass
                    and conname = 'segments_engaged_index_in_range') then
    alter table public.segments add constraint segments_engaged_index_in_range
      check (engaged_index is null or (engaged_index >= 0 and engaged_index < target_count)) not valid;
  end if;
end $$;

-- TOAST compression for the three payload columns. Every one of these blobs is
-- far over the ~2 kB TOAST threshold, so all of them are compressed and pushed
-- out of line on every insert — which makes the compressor a per-insert CPU
-- cost paid by every concurrent writer. lz4 is markedly faster than the default
-- pglz at a comparable ratio on this shape of data (long runs of repetitive
-- numeric headers), so this is throughput, not disk.
--
-- Applies to newly written values only; existing rows keep whatever they were
-- written with, which is fine because both algorithms stay readable.
-- Deliberately NOT `set storage external` — that would disable compression
-- entirely and roughly triple the disk these columns occupy.
--
-- Wrapped so a server built without lz4 degrades to a notice instead of
-- rolling back the entire migration (the whole file is one transaction).
do $$
begin
  alter table public.segments alter column trajectory       set compression lz4;
  alter table public.segments alter column input_events     set compression lz4;
  alter table public.segments alter column board_trajectory set compression lz4;
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

create table if not exists public.session_metrics (
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
-- It stores raw_subject_id, NEVER a resolved label. kind/cohort/merged_into are
-- joined LIVE from subjects at train time, so retroactive relabelling still
-- works after a session is archived (label a contributor today, every archived
-- session of theirs reclassifies). Freezing is_human here would destroy that.
--
-- Service-key only: RLS on, zero client policies. The client never reads or
-- writes it, exactly like the archive job's Storage bucket.
create table if not exists public.archive_manifest (
  session_id        uuid primary key references public.sessions(id) on delete cascade,
  raw_subject_id    uuid not null references public.subjects(subject_id),
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

create index if not exists sessions_subject_started_idx
  on public.sessions (subject_id, started_at desc);
create index if not exists sessions_routine_difficulty_idx
  on public.sessions (routine, difficulty);
-- No separate (session_id, segment_index) index: segments_session_order's
-- unique constraint above already is that index; a second one would only add
-- write overhead with no query it serves that the first doesn't.
drop index if exists public.segments_session_idx;
-- segments_outcome_idx is DROPPED, not merely unused. `outcome` has four
-- distinct values on what will be the largest table here, so the planner will
-- never choose it over a sequential scan; and nothing queries it anyway —
-- segments has no select policy at all, and the training pull filters on
-- routine and label, never outcome. It was also actively harmful: Postgres
-- appends the heap TID as an implicit btree tiebreaker, so on an append-only
-- table every insert of a given outcome lands at the right edge of that key's
-- range. Four values means four hot leaf pages shared by every concurrent
-- writer — buffer-content-lock contention that scales with user count, paid on
-- every insert, for a read that never happens. Do not reinstate it.
drop index if exists public.segments_outcome_idx;
create index if not exists subjects_kind_idx
  on public.subjects (kind);
-- Resolving a subject to its canonical identity in the training view, and
-- listing everything merged into a survivor.
create index if not exists subjects_merged_into_idx
  on public.subjects (merged_into);
-- Incremental pulls ("every segment since the last fetch") and the archive job's
-- age selection both need to range-scan created_at. BRIN, not btree, precisely
-- because the table is append-only: created_at is perfectly correlated with
-- physical row order, which is the one case BRIN is built for. It costs a few kB
-- (a btree would be hundreds of MB) and, unlike a btree, adds no hot right-edge
-- leaf page for every concurrent writer to contend on — the same contention that
-- got segments_outcome_idx dropped above.
create index if not exists segments_created_at_brin
  on public.segments using brin (created_at);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Append-only for the client. There is no update or delete policy anywhere: a
-- behavioural reference set an account holder can rewrite is not a reference
-- set. Corrections are made with the service key.
--
-- anon has no privileges at all — inserting requires a signed-in user whose
-- subject the row already belongs to.

alter table public.subjects        enable row level security;
alter table public.profiles        enable row level security;
alter table public.sessions        enable row level security;
alter table public.segments        enable row level security;
alter table public.session_metrics enable row level security;
-- archive_manifest gets RLS on and NO policy of any kind: it is written and read
-- only with the service key by the offline archive job. RLS-on-no-policy denies
-- the client everything, which is the whole intent.
alter table public.archive_manifest enable row level security;

-- The v1 `telemetry_logs_v1` table used to be sealed here (RLS on, all grants
-- revoked from anon and authenticated). It has been dropped, so there is
-- nothing left to seal — see the Legacy note at the top of this file.

-- subjects: no client policy of any kind. `kind` in particular must stay
-- unwritable, or a synthetic run could relabel itself human.

-- profiles: a user may read their own row (display name, consent state) and
-- update the two consent columns. The subject link is not writable.
drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own"
  on public.profiles for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
  on public.profiles for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and subject_id = (select public.current_subject_id()));

-- RLS alone cannot restrict *which columns* an update touches — the policy
-- above passes for any column value as long as user_id/subject_id are intact.
-- Column-level grants are what actually confine a write to the two consent
-- columns, matching the comment above this table; without this, display_name
-- and created_at are just as writable via the same policy.
revoke update on public.profiles from authenticated;
grant update (consent_version, consented_at) on public.profiles to authenticated;

-- sessions: insert and read your own. The extra null checks stop a client from
-- planting a value in a column documented as SERVICE-WRITTEN (see sessions
-- above) at insert time — there is no update policy to fix it afterwards, so
-- a forged value here would otherwise stand forever.
drop policy if exists "sessions insert own" on public.sessions;
create policy "sessions insert own"
  on public.sessions for insert to authenticated
  with check (
    subject_id = (select public.current_subject_id())
    -- Consent is a server-side precondition for writing biometric data, not only
    -- a client gate (canPlay()/applyStartGate()). Existence, not version match —
    -- see current_consent_version(). Scalar-subquery form for the InitPlan reason
    -- the other policies document.
    and (select public.current_consent_version()) is not null
    and ended_at is null
    and poll_hz is null
    and bot_mode is null
  );

drop policy if exists "sessions select own" on public.sessions;
create policy "sessions select own"
  on public.sessions for select to authenticated
  using (subject_id = (select public.current_subject_id()));

-- Column-level insert grant. RLS gates which ROWS you may insert, never which
-- COLUMNS — the policy above passes for any value of any column. So the fields
-- documented as SERVICE-WRITTEN (started_at, ended_at, poll_hz, bot_mode) were
-- forgeable despite their comments. Revoking table-level insert and granting it
-- per column is what actually confines the client, exactly as the profiles
-- UPDATE grant does. `id` IS granted: the client mints the session uuid so a
-- segment can be enqueued before the row's insert resolves (see supabase.js); a
-- collision merely raises 23505 and leaks nothing.
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
drop policy if exists "segments insert own" on public.segments;
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
  board_trajectory, frame_count, event_count, duration_ms
) on public.segments to authenticated;

-- session_metrics: read your own. Writes are service-key only.
drop policy if exists "session metrics select own" on public.session_metrics;
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
-- `where is_human is not null` — never coerced or imputed. A boolean CLI flag
-- cannot express that filter, so the pipeline needs a three-state option.
-- subject_kind_source is the audit column: once
-- subjects_label_has_provenance is validated, `is_human is not null` already
-- implies a deliberate label, so adding
-- `and subject_kind_source in ('provisioned','reviewed')` should never change
-- the row count — if it does, that constraint was never promoted.
--
-- security_invoker so the view runs with the caller's privileges, not the
-- owner's. The real protection is the revoke below (only the service key, which
-- bypasses RLS, can read it); security_invoker removes the footgun where a
-- single future GRANT would otherwise expose every subject's trajectories
-- through an owner-privileged view.
--
-- subject_id is the CANONICAL identity: merged duplicates collapse onto their
-- survivor via merged_into, so this is the correct grouping key for a
-- train/test split. raw_subject_id keeps the un-collapsed value for auditing a
-- merge. Collapsing here means a later merge is a single UPDATE with zero
-- pipeline changes.
--
-- Dropped and recreated rather than CREATE OR REPLACE: replace can only append
-- columns to the end of an existing view, and this revision both changes the
-- is_human expression and inserts the provenance columns mid-list, which
-- replace rejects. The view holds no data, so dropping it is free.

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

drop view if exists public.v_training_segments;

create view public.v_training_segments
with (security_invoker = true) as
select
  g.id                              as segment_id,
  s.id                              as session_id,
  coalesce(sub.merged_into, sub.subject_id) as subject_id,
  sub.subject_id                    as raw_subject_id,
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
  -- Provenance. Audit-grade rather than load-bearing: see the header above.
  sub.kind_source                   as subject_kind_source,
  sub.cohort                        as subject_cohort,
  sub.labeled_at                    as subject_labeled_at,
  -- So a training set is auditably consented without a second query.
  sub.consent_version               as subject_consent_version,
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
  s.ended_at          as session_ended_at,
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
  g.board_trajectory,
  g.frame_count,
  g.event_count,
  g.duration_ms
from public.segments g
join public.sessions s   on s.id = g.session_id
join public.subjects sub on sub.subject_id = s.subject_id;

revoke all on public.v_training_segments from anon, authenticated;
