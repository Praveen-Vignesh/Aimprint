-- Migration 2026-10-19: add the model `predictions` table.
--
-- PASTE AS ONE BUFFER into the Supabase SQL editor — never in chunks. The whole
-- file runs as one implicit transaction; a chunked paste loses that.
--
-- Why a dated migration and not an edit to schema.sql: schema.sql is a
-- from-scratch, run-once-on-empty file (see its header) and must NOT be turned
-- back into a migration. This file is the change for the LIVE database (which
-- has data). The same `create table` is ALSO mirrored into schema.sql as a plain
-- create, so a future clean rebuild includes it — that mirror is not a migration
-- wrapper, just the table's home in the from-scratch file.
--
-- What this adds: a service-key-only home for model predictions. It is the
-- SEPARATE place guesses live — never session_metrics (the player can read their
-- own row there and would see their bot-score) and never subjects.kind (that is
-- human-decided ground truth; a retrain consuming its own past guesses amplifies
-- its errors). RLS on, ZERO policies — same posture as archive_manifest, so the
-- client can neither read nor write it; only the service key (which bypasses RLS)
-- touches it.

create table public.predictions (
  subject_id        uuid not null references public.subjects(subject_id) on delete cascade,
  -- Which model produced this guess (registry.py: date + family + content hash).
  -- Part of the PK so re-scoring under a new model APPENDS a row rather than
  -- overwriting the old guess — the prediction history is kept, not clobbered.
  model_version     text not null,
  scored_at         timestamptz not null default now(),
  -- Mean P(bot) over the subject's segments (the hierarchical aggregation).
  bot_probability   double precision not null
    constraint predictions_prob_range check (bot_probability >= 0 and bot_probability <= 1),
  predicted_label   text not null
    constraint predictions_label_allowed check (predicted_label in ('human', 'synthetic')),
  n_segments        int not null constraint predictions_n_segments_positive check (n_segments > 0),
  -- Which feature-set shape produced it (mirrors sampling_version's role).
  features_version  int not null default 1,
  -- Open bag for extras (vote_share, per-routine breakdowns) without a migration.
  notes             jsonb,
  primary key (subject_id, model_version)
);

-- RLS on, no policy of any kind: service-key only. The anon/publishable key the
-- browser carries can neither read nor write this table, so a suspected bot can
-- never read its own score and adapt. Identical to archive_manifest.
alter table public.predictions enable row level security;

-- An index for "show me every subject this model flagged", the one read the
-- operator actually makes.
create index predictions_model_label_idx
  on public.predictions (model_version, predicted_label);
