"""Skill-stats job: compute per-session aim aggregates and write them to
`session_metrics`. This is player-facing feedback ("how is my aim?") and has
NOTHING to do with the bot model — it is a separate offline job that happens to
share the service key.

Run from model/:
    python -m src.compute_session_metrics            # all sessions, all subjects
    python -m src.compute_session_metrics --dry-run

Aggregates (one row per session), matching the session_metrics columns:
  accuracy              hits / (hits + miss + timeout)   [timeouts count against
                                                          accuracy per CLAUDE.md]
  mean_time_to_click_ms over hit+miss segments (click-only, NaN elsewhere)
  mean_dwell_ms         over segments where dwell registered
  on_target_ratio       frame-weighted mean of per-segment on-target fraction
The open `metrics` jsonb carries the raw outcome counts for auditing.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.common import fetch_telemetry  # noqa: E402
from src.common.features import build_segment_features  # noqa: E402

SESSION_METRICS_TABLE = "session_metrics"
ALL_KINDS = ["human", "synthetic", "unknown"]  # skill stats are for every player


def _clean(value):
    """JSON/Postgres-safe float: NaN -> None."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    return float(value)


def compute(sampling_version: int = 1) -> pd.DataFrame:
    raw = fetch_telemetry.fetch_core(ALL_KINDS, sampling_version=sampling_version)
    if raw.empty:
        return pd.DataFrame()
    feats = build_segment_features(raw)

    out = []
    for session_id, g in feats.groupby("session_id"):
        outcome = g["outcome"]
        hits = int((outcome == "hit").sum())
        miss = int((outcome == "miss").sum())
        timeout = int((outcome == "timeout").sum())
        track = int((outcome == "track").sum())
        attempts = hits + miss + timeout

        frames = g["frame_count"].to_numpy(dtype=float)
        on = g["on_target_ratio"].to_numpy(dtype=float)
        mask = ~np.isnan(on) & (frames > 0)
        on_target_ratio = (float(np.sum(on[mask] * frames[mask]) / np.sum(frames[mask]))
                           if mask.any() else None)

        out.append({
            "session_id": session_id,
            "accuracy": (hits / attempts) if attempts else None,
            "mean_time_to_click_ms": _clean(g["time_to_click_ms"].mean()),
            "mean_dwell_ms": _clean(g["dwell_ms"].mean()),
            "on_target_ratio": on_target_ratio,
            "metrics": {"hits": hits, "miss": miss, "timeout": timeout,
                        "track": track, "attempts": attempts,
                        "n_segments": int(len(g))},
        })
    return pd.DataFrame(out)


def main():
    ap = argparse.ArgumentParser(description="Compute + write player skill stats to session_metrics.")
    ap.add_argument("--dry-run", action="store_true", help="print rows, do not write")
    args = ap.parse_args()

    df = compute()
    if df.empty:
        sys.exit("No sessions found to summarise.")
    print(f"Computed metrics for {len(df)} session(s).")
    print(df[["session_id", "accuracy", "mean_time_to_click_ms", "on_target_ratio"]].to_string(index=False))

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return

    client = fetch_telemetry._client()
    rows = [
        {
            "session_id": r["session_id"],
            "accuracy": _clean(r["accuracy"]),
            "mean_time_to_click_ms": r["mean_time_to_click_ms"],
            "mean_dwell_ms": r["mean_dwell_ms"],
            "on_target_ratio": r["on_target_ratio"],
            "metrics": r["metrics"],
        }
        for _, r in df.iterrows()
    ]
    written = client.table(SESSION_METRICS_TABLE).upsert(rows).execute().data
    print(f"\nWrote {len(written)} row(s) to {SESSION_METRICS_TABLE}.")


if __name__ == "__main__":
    main()
