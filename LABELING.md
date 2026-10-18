# Label integrity — `subjects.kind` is default-deny

> ## STATUS — schema applied from scratch on a wiped database 2026-10-18
> **The label fix is live by construction. §5.6 (labelling the batches) is the
> only step that remains, and it cannot start before recruitment.**
> This block is the single place in the repo that answers "is the label fix
> actually live". Keep it current by hand.
>
> On 2026-10-18 all collected telemetry was deleted and `schema.sql` was
> rewritten as one from-scratch DDL file (it is no longer an idempotent
> migration — see its header) and applied clean in one buffer. Everything the
> old STATUS block and its addenda tracked step by step is now simply **how the
> tables are defined**, so there is nothing left to "roll out":
>
> - `subjects.kind` defaults to `'unknown'`, `subjects_kind_allowed` permits the
>   three values, and `kind_source` / `cohort` / `labeled_at` exist — all inline
>   in the `create table`.
> - `subjects_label_has_provenance` is declared **inline and validated** (not
>   `NOT VALID`). The old manual §5.5 `validate constraint` step is therefore
>   **gone** — there are no pre-existing rows to grandfather on an empty table.
> - `v_training_segments` exposes `subject_kind_source` / `subject_cohort` /
>   `subject_labeled_at`, and `is_human` is three-valued (`CASE` present).
> - There is **no `merged_into`** and no merge machinery: one `subjects` row is
>   one identity. The §5.7 divergent-label gate stays removed. If the same person
>   appears on two accounts, exclude the extra at labelling time (safe only
>   because the cohort is ~25 hand-recruited contributors labelled by email; a
>   public reopening would need merging back).
> - **Consent is gone entirely** (removed in the same pass): no
>   `consent_version` / `consented_at` on `profiles` or `subjects`, no
>   `current_consent_version()`, no `mirror_consent_to_subject()` trigger, no
>   consent clause in the `sessions` insert policy. Agreement is now part of
>   creating an account. Nothing in this runbook references it any more.
>
> After a fresh sign-up every subject sits at `kind='unknown',
> kind_source='default'` — unlabelled, correctly excluded from any training pull
> until §5.6 labels it.
>
> Remaining: **§5.6 only** (labelling bot accounts and trusted human
> contributors). It cannot start before Phase 6 recruitment / bot provisioning,
> and §5.6 has the exact batch-`UPDATE` statements. Labelling still works after a
> session is **archived** (`STORAGE.md`): the archive stores `subject_id`, and
> `is_human` / `cohort` are joined from `subjects` at train time, so relabelling
> stays retroactive across the archive boundary.

**What this document is.** Why the human-vs-bot ground-truth label was unsafe,
what changed, and the runbook for applying it. `schema.sql` is authoritative for
*what* the schema does; this file is for *why*, and for the operational steps
that live outside the file.

---

## 1. The problem

`handle_new_user()` runs `insert into public.subjects default values`, so every
column takes its default — and `kind` defaulted to `'human'`. **Every account
that ever signed up was labeled a confirmed human**, and the training view
emitted `sub.kind = 'human' as is_human`, feeding that straight into the
classifier.

The schema did not *guess* the label. It encoded **absence of information as a
positive claim**, which can only fail in one direction: an unlabeled bot becomes
a human, never the reverse. Bots inside the human class teach the classifier that
bot-like behaviour *is* human behaviour — not generic noise, but targeted erosion
of the exact signal the model exists to detect.

**The fix:** default-deny, mirroring the schema's own RLS philosophy — RLS on
with zero policies denies everything; trust is granted explicitly, never assumed.

### Why this is cheap

`kind` lives on `subjects` and the view **joins it live** rather than stamping it
onto each segment row, so **relabelling is retroactive**. A contributor can play
twenty sessions while `'unknown'`, get labeled afterward, and every past segment
reclassifies automatically. That is what makes post-hoc manual labelling correct
rather than a workaround — and it is why the labelling window in §5 costs nothing.

---

## 2. What changed

All in `schema.sql` — read it for the exact SQL and the inline rationale. No
client changes: `src/supabase.js` never touches `subjects`. No trigger change:
`handle_new_user()` uses `default values`, so flipping the column default
suffices.

| Change | Why |
|---|---|
| `kind` gains `'unknown'`, which becomes the **default** | The fix itself. |
| The inline unnamed CHECK is replaced by a named `subjects_kind_allowed`, discovered via `conkey` | The original was inline and unnamed, so Postgres auto-generated its name. A by-name drop that missed would leave the old two-value constraint ANDed with the new one. |
| View's `is_human` becomes **three-valued** via `CASE` | **Not optional.** See the hazard below. |
| View exposes `subject_kind_source`, `subject_cohort`, `subject_labeled_at` | `kind_source` existed in the table but was never carried into the view, so the pipeline could not distinguish "verified" from "merely defaulted". |
| `cohort` + `labeled_at` columns | Hold out a whole bot variant in a split; know *which* bot evaded detection; keep a paper trail. |
| `subjects_label_has_provenance` (`NOT VALID`) | A label can never exist without its provenance. |
| Labelling runbook as a comment block in `schema.sql` | No helper function — see below. |
| One-buffer warning in the file header | See D1 in §7. |

> ### ⚠️ The three-valued view was mandatory, not cosmetic
> There was **no bug in the view before this change**: `kind` only held
> `'human'` or `'synthetic'`, which `sub.kind = 'human'` mapped correctly. The
> bug is *created* by adding `'unknown'` — that expression maps it to `false`,
> i.e. **"confirmed bot."** Widening `kind` without rewriting the view would hand
> every unlabeled stranger to the model as a verified non-human, silently.

> ### ⚠️ Why there is no labelling helper function
> PostgREST auto-exposes **every** function in the `public` schema as
> `POST /rest/v1/rpc/<name>`. Postgres grants `EXECUTE` to `PUBLIC` by default
> (unlike tables), and Supabase's default privileges grant it to `anon` and
> `authenticated` on top. A `security definer` function writing `subjects.kind`
> would be **callable by anyone holding the publishable key inlined into the Vite
> bundle** — breaking the invariant the RLS section exists to protect. The batch
> `UPDATE` is also simply better for the real workload ("label fifteen bots, then
> eight friends" = two statements). If ergonomics ever justify a helper, put it in
> a schema PostgREST does not expose and make it `security invoker`.

---

## 3. Order of operations inside `schema.sql`

One ordering constraint is load-bearing and will take the site down if reversed:

**The constraint widening must come before `alter column kind set default`.**
`SET DEFAULT` is not validated against CHECK constraints at ALTER time — it only
coerces the expression to the column type and writes `pg_attrdef`, evaluating no
constraint and scanning no rows. Reverse them and nothing looks wrong until the
next signup: the trigger's insert supplies `'unknown'`, the old CHECK rejects it,
the exception escapes the `security definer` trigger, and the `insert into
auth.users` **aborts**. GoTrue returns 500 and signup is broken for every new
user, with a schema file that reads perfectly correct.

The file is already in the correct order. Do not reorder it.

---

## 4. Applying it to the database

> ### 🚨 PASTE THE FILE AS ONE BUFFER — NEVER IN CHUNKS
> Postgres runs a multi-statement simple query as a **single implicit
> transaction**, so any failure rolls the whole run back and no intermediate
> state is ever visible. Chunking destroys that guarantee.
>
> The sharpest edge is the `drop trigger if exists on_auth_user_created` /
> `create trigger` pair. A signup landing between them gets an `auth.users` row
> with **no `subjects` row and no `profiles` row** — after which the client
> resolves a null `subject_id` and silently drops every telemetry row that
> account ever produces, permanently, with no error anywhere. **Nothing in the
> file repairs such a user.**
>
> That `drop trigger` also holds ACCESS EXCLUSIVE on `auth.users` until the run
> commits, so signups *block* (they do not fail) for its duration. Prefer a
> low-traffic moment.

1. Paste all of `schema.sql` into the Supabase SQL editor as one buffer. Run it.
2. Confirm no users were stranded:
   ```sql
   select u.id, u.email, u.created_at from auth.users u
     left join public.profiles p on p.user_id = u.id
    where p.user_id is null;                                  -- expect 0 rows
   ```

---

## 5. Manual steps

> **5.1–5.5 are HISTORICAL as of the 2026-10-18 from-scratch apply.** They were
> the one-time steps for migrating a database that *already held data* onto the
> default-deny label: verify the rebuilt view, pre-flight for rows that would
> block the validate, resolve them, backfill mislabelled `'human'` rows, then
> promote the constraint. On a database created empty from the current
> `schema.sql` none of them apply — `subjects_label_has_provenance` is declared
> validated inline, and there are no pre-existing rows to correct. They are kept
> below only as the runbook to reach for if real data is ever migrated again
> rather than wiped. **The one live step is §5.6.**

### 5.1 Verify the view FIRST (before any backfill) — *historical, see banner*

```sql
select is_human, subject_kind, subject_kind_source, subject_cohort
  from public.v_training_segments limit 5;
```

This must succeed and show the new columns. **If the view was not rebuilt but
the schema was widened, the backfill below would flip strangers to `'unknown'`,
which the old expression maps to `false` — "confirmed bot" — and
`where is_human is not null` would not catch it.** Verify before, not after.

### 5.2 Pre-flight: see everything that will block the validate — *historical*

```sql
select subject_id, created_at, kind, kind_source
  from public.subjects
 where kind <> 'unknown' and kind_source = 'default'
 order by created_at;
```

Note the **broad** predicate (`kind <> 'unknown'`), not just `kind = 'human'`.
The backfill in 5.4 only touches `'human'` rows, but `validate constraint` in
5.5 checks *all* rows — so a `kind='synthetic', kind_source='default'` row would
survive the backfill and then block the validate with no obvious remedy.

### 5.3 Resolve any `synthetic` / `default` rows by hand — *historical*

If 5.2 returned rows with `kind='synthetic'`, they are a judgement call, not a
mechanical backfill. Either they are genuinely provisioned bots — set
`kind_source='provisioned'` and stamp `labeled_at` — or they are junk, and
should go to `kind='unknown'`. Decide explicitly before continuing.

### 5.4 Backfill — *historical*

```sql
update public.subjects
   set kind = 'unknown'
 where kind = 'human' and kind_source = 'default'
returning subject_id, created_at, kind, kind_source;
```

Every matching row was labeled `'human'` by nothing but the old column default —
`kind_source='default'` means precisely "nobody decided this."

**Safe to re-run:** afterward no row matches, and new signups arrive as
`'unknown'`. The one case where a re-run could do damage — a hand-set `kind`
whose `kind_source` was left at `'default'` — is exactly what
`subjects_label_has_provenance` now makes impossible.

`labeled_at` is deliberately left NULL: these subjects were never labeled, and
stamping a timestamp would manufacture provenance that does not exist.

> **Your own account is in this set** and becomes `'unknown'` until you re-label
> it in 5.6.

### 5.5 Promote the constraint — *historical; now validated inline*

```sql
alter table public.subjects validate constraint subjects_label_has_provenance;
```

Until this runs, the constraint enforces on new writes but was never checked
against existing rows. A **fresh** database has nothing to backfill and should
run this immediately, or it stays permanently unvalidated.

### 5.6 Label the batches

Use the runbook in `schema.sql` (search for "Labelling a subject"). One statement
for bot accounts (`kind_source='provisioned'`, one `cohort` per bot variant), one
for human contributors (`kind_source='reviewed'`). Check the `returning` row
count against the number of emails you passed — **zero rows back means nothing
was labeled.**

### 5.7 ~~Required gate: divergent labels across merged duplicates~~ — REMOVED

This gate existed only because `merged_into` let two rows describe one person
while `kind` was read off the raw row, so labelling one account and missing the
other silently dropped half that subject's segments.

**Merging was removed on 2026-10-17.** One `subjects` row is now one identity, it
carries exactly one `kind`/`cohort`, and there is nothing to diverge — so there
is no gate to run. If you spot the same person on two accounts, exclude the
extra account instead.

---

## 6. Verification

```sql
-- CRITICAL: signup is not broken
insert into public.subjects default values returning subject_id, kind;  -- 'unknown'
-- delete that row, then do a REAL signup through the app and confirm a
-- profiles row and a subjects row appear with kind='unknown'

-- Exactly one check on kind, three values, no leftover auto-named constraint
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.subjects'::regclass and contype='c';
-- expect subjects_kind_allowed (3 values), subjects_kind_source_check,
-- subjects_label_has_provenance — and NO subjects_kind_check

select column_default from information_schema.columns
 where table_schema='public' and table_name='subjects' and column_name='kind';

-- The view is NOT readable by the client roles
select relacl from pg_class where oid='public.v_training_segments'::regclass;

-- Nothing labelled without provenance
select count(*) from public.subjects
 where kind <> 'unknown' and kind_source = 'default';         -- expect 0

-- Label state at a glance
select kind, kind_source, cohort, count(*)
  from public.subjects group by 1,2,3 order by 1,2,3;
```

Browser check: fresh signup lands `kind='unknown'`, gameplay still writes
`sessions`/`segments` normally.

*(If the pipeline ever 404s on `v_training_segments` right after a re-run, that
is PostgREST's schema cache; `notify pgrst, 'reload schema';` fixes it. Supabase
auto-reloads via an event trigger, so it should not occur.)*

---

## 7. Contract for the offline pipeline (`model/`, not yet written)

### 7.1 Filter at fetch, not at fit

```sql
select * from public.v_training_segments
 where is_human is not null
   and subject_kind_source in ('provisioned', 'reviewed');
```

The first clause is **mandatory** — it excludes unlabeled strangers. The second
is a **tripwire**: after 5.5 it is logically implied by the first, so if it ever
changes the row count, `subjects_label_has_provenance` was never validated.

Filter at fetch because a NaN label reaching sklearn fails inside `fit()`, far
from the cause. Note also that `df[df.is_human]` silently drops nulls in pandas —
correct by accident, fragile by design.

`--label` must be three-state (`human` | `synthetic` | `any`), never a boolean
`--is-human`: a two-state flag cannot express "exclude the unlabelled."

### 7.2 Split by subject, and watch for hardware leakage

Not a schema concern, and probably the most likely reason the model fails while
appearing to succeed.

If every bot runs on one machine and every human is a contributor on their own,
a random forest will learn `refresh_hz` / `dpi` / `device_fingerprint` /
`cm_per_360` and score ~99% **without learning anything about aim** — then
collapse against real users. The `sessions` hardware-block comment already
anticipates exactly this.

- **Split train/test by `subject_id`, never by row** (`GroupKFold`). The view's
  `subject_id` is that grouping key — one subject row is one identity, with no
  merge/collapse step.
- **Train twice — with and without the hardware block — and compare.** A large
  gap means the model learned hardware.
- **Vary the bots' hardware**, or run variants on more than one machine.
- **Hold out an entire person**, not a sample of their rows.
- Use `subject_cohort` to hold out a whole bot variant.

**Honest limitation:** a handful of contributors is a small human class. The
first model will likely learn "is this one of these few people" rather than "is
this a human," and no schema change fixes that. Treat v1 as a proof of concept.

### 7.3 Never write predictions into `subjects.kind`

Not a bug — a fork in the road that arrives immediately after the model is
hosted, where one option is quietly poisonous.

1. Model is live. A stranger plays. It outputs "78% likely bot." That is a
   **guess**.
2. Tempting: `update subjects set kind='synthetic' where subject_id=...`
3. Six months later you retrain, pulling everything where `kind='synthetic'` —
   which now contains **your real hand-built bots** *and* **accounts the previous
   model guessed about**.
4. Wherever the old model was wrong, the new model learns those errors as
   verified ground truth and grows *more* confident in them. Compounds per
   retrain, degrades silently, very hard to diagnose afterwards.

**The rule:** `subjects.kind` holds ground truth established by a person, and
nothing else. Predictions get their own table, built when the model exists.
`subjects_label_has_provenance` helps enforce this culturally — a prediction has
no honest `kind_source` to claim.

---

## 8. Review log

### 8.1 The original problem list, after challenge

The first analysis listed six problems. Under review, two did not survive.

| Original claim | Outcome |
|---|---|
| **P1** every signup labeled human | **Stands.** The one real bug; everything above exists for it. |
| **P2** `kind_source` invisible to the pipeline | **Stands, downgraded.** The confusion was legitimate: the column was never missing from the *table*, only from the *view* — and the pipeline reads the view. But once P1 is fixed, backfilled, and the provenance constraint is in place, `kind='human'` already implies a deliberate decision, so this is audit-grade, not critical. An earlier draft overstated it. |
| **P3** `is_human` conflates bot and unknown | **Retracted as a problem.** Challenged on the grounds that only two columns exist and P1/P2 already covered them — correct. There was no bug; it arises *only* as a consequence of fixing P1, so it is now the hazard warning in §2 rather than an independent item. |
| **P4** email is not a trust signal | **Resolved.** External SMTP verification plus shipped Google OAuth answer the forgery objection. Manual labelling survives on simplicity grounds instead (two statements vs. a table plus trigger logic for a couple dozen one-time accounts). |
| **P5** prediction feedback loop | **Stands, reframed.** Never a current bug; presenting it alongside real ones obscured that. Now §7.3. |
| **P6** hardware leakage | **Stands, promoted.** Untouched by review, and arguably the most consequential item for whether the model works at all. Now §7.2. |

**Net:** one real bug, one cheap plumbing fix, one ML trap, two forward-looking
rules.

### 8.2 Defects found in the implementation spec itself

A final adversarial pass over the migration SQL, before it was written, confirmed
the design was sound — the `conkey` discovery is correct across fresh /
current-live / already-migrated databases, the constraint-before-default ordering
claim holds, the backfill provably cannot be rejected by its own constraint, and
RLS does not block it (owner exemption plus `BYPASSRLS`). It also found six
defects, all now fixed:

| | Defect | Fix |
|---|---|---|
| D1 | The `drop trigger on_auth_user_created` chunked-paste window — a signup landing in it is permanently unrecordable, silently | One-buffer warning in the file header + orphan-detection query (§4) |
| D2 | Verification was ordered *after* the backfill, but the view check is a **precondition** of it | §5.1 now runs first |
| D3 | `validate constraint` checks all rows; the backfill only touched `kind='human'` | §5.2 broadened to `kind <> 'unknown'`; §5.3 added |
| D4 | `merged_into` duplicates can now carry divergent labels → silent data loss | §5.7 promoted to a required gate — *since moot: merging removed 2026-10-17, §5.7 retired* |
| D5 | The view's own header comment still described a plain boolean — and it is the canonical contract for `fetch_telemetry.py` | Rewritten in `schema.sql` |
| D6 | `CLAUDE.md` specified a boolean `--is-human` CLI flag for a now-three-valued column | Replaced with three-state `--label`; 4 `CLAUDE.md` sites updated, not 2 |

**D4 note:** the alternative was resolving `kind` through the canonical row in
the view, so labelling the survivor would suffice. Rejected — the labelling
runbook resolves email → `profiles` → the **raw** subject, so that change would
make the documented workflow's labels invisible. Gate, don't re-architect.

---

## 9. Known-stale elsewhere

Nothing outstanding. `TELEMETRY.md`, which used to be listed here for describing
`is_human` as a plain boolean passed unchanged into `features.py`, **no longer
exists in this repo** — the concern died with the file. The three-valued contract
now lives in §7.1 above and in `model/DESIGN.md`.

`schema.sql` (the comment above `v_training_segments`) names `fetch_telemetry.py`
as the view's consumer. That is a forward reference to unwritten code, not
evidence the pipeline exists.
