"""Pulls v_training_segments out of Supabase with the service key and writes a
decoded parquet the feature stage can read.

Run from model/ as a module:
    python -m src.fetch_telemetry --routine flick --label any --out data/flick.parquet

Properties that are mandatory, not optional (schema.sql view header,
model/DESIGN.md):
  * Label filter uses `subject_kind in (...)`, never `is_human is not null`:
    is_human is a CASE expression (non-sargable); subject_kind is a plain
    column. `--label any` means human+synthetic and ALWAYS excludes unlabelled
    (unknown) subjects — training on unlabelled strangers is the exact bug the
    default-deny label exists to prevent.
  * Keyset pagination on (segment_created_at, segment_id), never LIMIT/OFFSET:
    the view has no intrinsic order, so OFFSET skips and duplicates rows.
  * sampling_version is always filtered on (default 1), never assumed.
  * Nested columns (trajectory/input_events/targets/routine_config) are decoded
    through codec.py, then re-serialized to JSON strings before parquet, so the
    file round-trips without depending on pyarrow struct inference.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.common.codec import decode_segment  # noqa: E402

VIEW = "v_training_segments"
PAGE_SIZE = 1000  # PostgREST caps a single response here regardless
JSON_COLUMNS = ["trajectory", "input_events", "targets", "routine_config"]

LABEL_KINDS = {
    "human": ["human"],
    "synthetic": ["synthetic"],
    "any": ["human", "synthetic"],
}


def _client():
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in model/.env")
    if url.rstrip("/").endswith("/rest/v1"):
        sys.exit("SUPABASE_URL must be the bare origin, with no /rest/v1 suffix")
    return create_client(url, key)


def _page(client, kinds, sampling_version, routine, cursor, subject_ids=None):
    """One keyset page. `cursor` is (created_at, segment_id) of the last row of
    the previous page, or None for the first page."""
    q = (
        client.table(VIEW)
        .select("*")
        .in_("subject_kind", kinds)
        .eq("sampling_version", sampling_version)
    )
    if subject_ids:
        q = q.in_("subject_id", subject_ids)
    if routine:
        q = q.eq("routine", routine)
    if cursor is not None:
        created_at, segment_id = cursor
        # (created_at, segment_id) > (cursor) as a composite, so no row is
        # skipped or repeated across the boundary.
        q = q.or_(
            f"segment_created_at.gt.{created_at},"
            f"and(segment_created_at.eq.{created_at},segment_id.gt.{segment_id})"
        )
    q = q.order("segment_created_at").order("segment_id").limit(PAGE_SIZE)
    return q.execute().data


def _decode_row(row: dict) -> dict:
    decoded = decode_segment(row)
    row = dict(row)
    row["trajectory"] = json.dumps(decoded["trajectory"])
    row["input_events"] = json.dumps(decoded["input_events"])
    # targets / routine_config pass through as-is but are JSON-stringified so
    # every nested column in the parquet is a plain string.
    for col in ("targets", "routine_config"):
        if col in row and not isinstance(row[col], str):
            row[col] = json.dumps(row[col])
    return row


def fetch_core(kinds, routine=None, sampling_version=1, subject_ids=None) -> pd.DataFrame:
    """Paginate the view for the given subject kinds (and optional subject-id
    filter), decoding every row. Reused by the scoring path, which passes
    kinds=['unknown'] (or a specific subject) — exactly the rows the training
    fetch excludes."""
    client = _client()
    cursor = None
    out_rows = []
    while True:
        page = _page(client, kinds, sampling_version, routine, cursor, subject_ids)
        if not page:
            break
        for row in page:
            out_rows.append(_decode_row(row))
        if len(page) < PAGE_SIZE:
            break
        last = page[-1]
        cursor = (last["segment_created_at"], last["segment_id"])
        print(f"  ...{len(out_rows)} rows")
    return pd.DataFrame(out_rows)


def fetch(routine: str | None, label: str, sampling_version: int) -> pd.DataFrame:
    return fetch_core(LABEL_KINDS[label], routine, sampling_version)


def main():
    ap = argparse.ArgumentParser(description="Pull decoded v_training_segments to parquet.")
    ap.add_argument("--routine", default=None, help="flick|spidershot|strafing|... (omit for all)")
    ap.add_argument("--label", choices=sorted(LABEL_KINDS), default="any",
                    help="human | synthetic | any (any = human+synthetic, never unlabelled)")
    ap.add_argument("--sampling-version", type=int, default=1)
    ap.add_argument("--out", required=True, help="output parquet path (under data/)")
    args = ap.parse_args()

    print(f"Fetching routine={args.routine or 'ALL'} label={args.label} "
          f"sampling_version={args.sampling_version}")
    df = fetch(args.routine, args.label, args.sampling_version)
    if df.empty:
        sys.exit("No rows returned — nothing labelled human/synthetic yet, or filters too narrow.")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    print(f"Wrote {len(df)} segments from {df['subject_id'].nunique()} subjects to {out}")


if __name__ == "__main__":
    main()
