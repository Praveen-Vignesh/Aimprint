"""The offline archive-and-prune job (STORAGE.md §3, DESIGN.md "The offline
archive job"). Keeps the Free-tier database under its 500 MB limit by moving aged
sessions' segments out to Parquet (local drive + private Supabase Storage),
verifying the written copy against the database, recording archive_manifest, then
deleting the staged segments. Runs by hand with the service key:

    python -m src.archive_telemetry --older-than 7d            # real run
    python -m src.archive_telemetry --older-than 7d --dry-run  # plan only, no writes/deletes

⚠️ THE HARD RULE (STORAGE.md): verify the written Parquet against the database
BEFORE deleting anything. This data cannot be re-collected. The verify step
re-reads the Parquet and asserts BOTH its row count AND a sha256 over the sorted
(session_id, segment_index) pairs equal the database's; a mismatch aborts the
prune with the rows still in Postgres.

Idempotent + late-arrival safe: a session that reacquires live segments after a
prune (an IndexedDB outbox replay landing days later) is simply re-archived,
re-verified and re-pruned — the manifest row is upserted.

The decode here is the SAME v1 codec as everywhere else (src.common.codec),
guarded by the JS→Python round-trip test (tests/test_codec.py) and this module's
own tests/test_archive.py. The job never resolves a label — it stores subject_id
only, so kind/cohort stay joined live from subjects at train time (retroactive
labelling, LABELING.md).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.common.codec import decode_segment  # noqa: E402
from src.common import fetch_telemetry  # noqa: E402

MANIFEST_TABLE = "archive_manifest"
SEGMENTS_TABLE = "segments"
SESSIONS_TABLE = "sessions"
DEFAULT_BUCKET = "telemetry-archive"
PAGE_SIZE = 1000

# Scalar segment columns carried into the archive verbatim (nested ones —
# trajectory/input_events/targets — are decoded/JSON-stringified separately).
SCALAR_COLUMNS = [
    "segment_index", "outcome", "started_at_ms", "target_distance",
    "time_to_click_ms", "dwell_ms", "click_offset_x", "click_offset_y",
    "target_count", "engaged_index", "frame_count", "event_count", "duration_ms",
]


# ---------------------------------------------------------------------------
# Pure helpers — no DB, no Storage. These are the safety-critical core and are
# unit-tested in tests/test_archive.py without any live connection.
# ---------------------------------------------------------------------------
def parse_lag(spec: str) -> timedelta:
    """'7d' / '24h' / '30m' / '0d' -> timedelta. The lag must comfortably exceed
    any IndexedDB outbox replay window, so 7d is the documented default."""
    m = re.fullmatch(r"\s*(\d+)\s*([dhm])\s*", spec or "")
    if not m:
        raise ValueError(f"--older-than must look like '7d', '24h' or '30m', got {spec!r}")
    n, unit = int(m.group(1)), m.group(2)
    return {"d": timedelta(days=n), "h": timedelta(hours=n), "m": timedelta(minutes=n)}[unit]


def content_sha256(pairs) -> str:
    """sha256 over the SORTED (session_id, segment_index) pairs — the fingerprint
    that gates the delete. Order-independent (sorted first) so the database-side
    and Parquet-side computations agree regardless of row order."""
    canon = "\n".join(
        f"{sid}:{int(idx)}"
        for sid, idx in sorted(pairs, key=lambda p: (str(p[0]), int(p[1])))
    )
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def decode_session_segments(raw_rows: list[dict], session_meta: dict) -> pd.DataFrame:
    """Decode one session's raw (wire-format) segment rows into the absolute,
    archive-ready DataFrame. Nested columns are decoded through the v1 codec and
    stored as JSON strings (same contract fetch_telemetry writes, so features.py
    reads archive Parquet and a live pull identically). Carries subject_id, NEVER
    a resolved label."""
    sv = session_meta["sampling_version"]
    out = []
    for raw in raw_rows:
        row = dict(raw)
        row.setdefault("sampling_version", sv)  # sampling_version lives on sessions
        decoded = decode_segment(row)
        rec = {
            "subject_id": session_meta["subject_id"],
            "session_id": session_meta["session_id"],
            "routine": session_meta["routine"],
            "difficulty": session_meta["difficulty"],
            "sampling_version": sv,
        }
        for col in SCALAR_COLUMNS:
            rec[col] = row.get(col)
        rec["targets"] = json.dumps(row.get("targets"))
        rec["trajectory"] = json.dumps(decoded["trajectory"])
        rec["input_events"] = json.dumps(decoded["input_events"])
        out.append(rec)
    df = pd.DataFrame(out)
    return df.sort_values("segment_index").reset_index(drop=True) if len(df) else df


def partition_path(sampling_version: int, routine: str, session_id: str) -> str:
    """Hive-partitioned object key (DESIGN.md step 2):
    segments/sampling_version=1/routine=flick/session_id=<uuid>.parquet"""
    return (f"segments/sampling_version={sampling_version}/"
            f"routine={routine}/session_id={session_id}.parquet")


def verify_parquet(path: str | Path, expected_count: int, expected_sha: str) -> tuple[bool, int, str]:
    """Re-read the WRITTEN Parquet and recompute count + content sha. The hard
    gate: returns (ok, got_count, got_sha); ok is True only when BOTH match the
    database-derived values. Called before any DELETE."""
    df = pd.read_parquet(path)
    pairs = list(zip(df["session_id"].tolist(), df["segment_index"].tolist()))
    got_sha = content_sha256(pairs)
    got_count = len(pairs)
    return (got_count == expected_count and got_sha == expected_sha), got_count, got_sha


# ---------------------------------------------------------------------------
# Live I/O — exercised only on a real run against Supabase + Storage. Not touched
# by the unit tests, and skipped entirely under --dry-run.
# ---------------------------------------------------------------------------
def _candidate_sessions(client, cutoff_iso: str) -> list[dict]:
    """Sessions whose started_at is older than the lag. Late-arrival handling is
    downstream: a session with 0 live segments is skipped; one with live segments
    (even if a manifest row already exists) is (re-)archived."""
    rows, page = [], 0
    while True:
        batch = (
            client.table(SESSIONS_TABLE)
            .select("id, subject_id, routine, difficulty, sampling_version, started_at")
            .lt("started_at", cutoff_iso)
            .order("started_at")
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
            .execute().data
        )
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def _session_segments(client, session_id: str) -> list[dict]:
    rows, page = [], 0
    while True:
        batch = (
            client.table(SEGMENTS_TABLE).select("*")
            .eq("session_id", session_id)
            .order("segment_index")
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
            .execute().data
        )
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def archive_one(client, session: dict, out_dir: Path, bucket: str, dry_run: bool) -> dict | None:
    """Archive a single session end-to-end with the verify-before-delete gate.
    Returns a summary dict, or None when the session has no live segments (already
    pruned, no late arrival)."""
    sid = session["id"]
    raw = _session_segments(client, sid)
    if not raw:
        return None  # nothing live — already archived and not resurfaced

    meta = {
        "session_id": sid, "subject_id": session["subject_id"],
        "routine": session["routine"], "difficulty": session["difficulty"],
        "sampling_version": session["sampling_version"],
    }
    df = decode_session_segments(raw, meta)
    db_pairs = [(sid, r["segment_index"]) for r in raw]
    db_count = len(db_pairs)
    db_sha = content_sha256(db_pairs)

    key = partition_path(meta["sampling_version"], meta["routine"], sid)
    local = out_dir / key
    local.parent.mkdir(parents=True, exist_ok=True)

    if dry_run:
        return {"session_id": sid, "segment_count": db_count, "storage_path": key,
                "would_write": str(local), "content_sha256": db_sha, "pruned": False}

    # (2-3) write local + upload to private Storage.
    df.to_parquet(local, engine="pyarrow", compression="zstd", index=False)
    with open(local, "rb") as fh:
        client.storage.from_(bucket).upload(
            key, fh.read(), {"content-type": "application/octet-stream", "upsert": "true"},
        )

    # (4) HARD GATE — verify the written Parquet before any delete.
    ok, got_count, got_sha = verify_parquet(local, db_count, db_sha)
    if not ok:
        raise RuntimeError(
            f"VERIFY FAILED for session {sid}: db=({db_count},{db_sha[:12]}) "
            f"parquet=({got_count},{got_sha[:12]}). Nothing deleted — rows remain in Postgres."
        )

    # (5) record the manifest, then prune, then stamp pruned_at.
    byte_size = os.path.getsize(local)
    client.table(MANIFEST_TABLE).upsert({
        "session_id": sid, "subject_id": meta["subject_id"],
        "routine": meta["routine"], "difficulty": meta["difficulty"],
        "sampling_version": meta["sampling_version"],
        "segment_count": db_count, "byte_size": byte_size,
        "storage_path": key, "local_path": str(local), "content_sha256": db_sha,
    }).execute()
    client.table(SEGMENTS_TABLE).delete().eq("session_id", sid).execute()
    client.table(MANIFEST_TABLE).update(
        {"pruned_at": datetime.now(timezone.utc).isoformat()}
    ).eq("session_id", sid).execute()

    return {"session_id": sid, "segment_count": db_count, "byte_size": byte_size,
            "storage_path": key, "content_sha256": db_sha, "pruned": True}


def main():
    ap = argparse.ArgumentParser(description="Archive aged sessions to Parquet and prune them.")
    ap.add_argument("--older-than", default="7d", help="session age lag: Nd | Nh | Nm (default 7d)")
    ap.add_argument("--out-dir", default="data/archive", help="local Parquet root")
    ap.add_argument("--bucket", default=DEFAULT_BUCKET, help="Supabase Storage bucket (private)")
    ap.add_argument("--dry-run", action="store_true", help="list what would archive; no writes/deletes")
    ap.add_argument("--limit", type=int, default=0, help="cap sessions processed (0 = all)")
    args = ap.parse_args()

    lag = parse_lag(args.older_than)
    cutoff = (datetime.now(timezone.utc) - lag).isoformat()
    client = fetch_telemetry._client()
    out_dir = Path(args.out_dir)

    sessions = _candidate_sessions(client, cutoff)
    if args.limit:
        sessions = sessions[: args.limit]
    print(f"{'DRY-RUN: ' if args.dry_run else ''}{len(sessions)} session(s) older than "
          f"{args.older_than} (cutoff {cutoff}).")

    archived = pruned = total_segments = 0
    for s in sessions:
        try:
            result = archive_one(client, s, out_dir, args.bucket, args.dry_run)
        except Exception as exc:
            print(f"  ! {s['id']}: {type(exc).__name__}: {exc}")
            print("  Stopping — fix the cause; nothing for this session was deleted.")
            sys.exit(1)
        if result is None:
            continue
        archived += 1
        total_segments += result["segment_count"]
        pruned += 1 if result.get("pruned") else 0
        tag = "would archive" if args.dry_run else ("archived+pruned" if result["pruned"] else "archived")
        print(f"  {tag}: {result['session_id']}  {result['segment_count']} segments  "
              f"sha={result['content_sha256'][:12]}")

    print(f"\n{'DRY-RUN complete' if args.dry_run else 'Done'}: "
          f"{archived} session(s), {total_segments} segments"
          f"{'' if args.dry_run else f', {pruned} pruned'}.")


if __name__ == "__main__":
    main()
