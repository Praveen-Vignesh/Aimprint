-- Migration 2026-10-19: add the `biometric_templates` table.
--
-- PASTE AS ONE BUFFER into the Supabase SQL editor — never in chunks (the file
-- runs as one implicit transaction).
--
-- Same discipline as the predictions migration: this is the change for the LIVE
-- database; the same `create table` is mirrored into schema.sql as a plain
-- create for a future clean rebuild. Do NOT turn schema.sql back into a
-- migration.
--
-- What this adds: the per-subject biometric signature store for the (future,
-- deploy-ready) behavioural-authentication gate. Each row is one subject's
-- template, built offline from their enrol sessions by model/src/biometric/enrol.py.
--
-- ⚠️ SECURITY — this table is the reason biometric auth is even defensible here:
-- RLS on, ZERO policies, service-key only. A client that could read its own
-- template could replay it to defeat the verification gate. This reverses, for
-- this one table, the project's usual "the player reads their own rows" posture,
-- and it must stay that way. Also: behavioural biometric auth at this data scale
-- is a SECONDARY risk signal, never a sole authentication factor.

create table public.biometric_templates (
  subject_id        uuid primary key references public.subjects(subject_id) on delete cascade,
  -- Which enrolment pass produced this template (date stamp from enrol.py). One
  -- template per subject; re-enrolling overwrites via upsert on the PK.
  template_version  text not null,
  enrolled_at       timestamptz not null default now(),
  -- The signature itself: {features, means, variances, n_enrol_sessions,
  -- n_enrol_segments, features_version}. jsonb so the shape can evolve without a
  -- migration. NEVER exposed to the client.
  signature         jsonb not null,
  n_enrol_sessions  int not null constraint biometric_templates_n_enrol_sessions_nonneg check (n_enrol_sessions >= 0),
  features_version  int not null default 1
);

-- RLS on, no policy of any kind: service-key only (templates must never be
-- client-readable — a readable template is a replayable one). Same posture as
-- predictions / archive_manifest.
alter table public.biometric_templates enable row level security;
