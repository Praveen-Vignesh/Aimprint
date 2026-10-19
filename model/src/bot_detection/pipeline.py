"""Thin orchestrator: fetch -> features -> train, in one command. Each stage is
still runnable alone (this just chains them); stages write parquet to data/ so a
failure is resumable from the last good artifact.

Run from model/:
    python -m src.bot_detection.pipeline --routine flick
    python -m src.bot_detection.pipeline              # all routines

Scoring (src.bot_detection.score) and the skill-stats job
(src.skill_stats.compute_session_metrics) are deliberately NOT chained here —
they run on their own cadence against a model this pipeline has already produced.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

MODEL_ROOT = Path(__file__).resolve().parents[2]
DATA = MODEL_ROOT / "data"


def _run(stage_args: list[str]):
    cmd = [sys.executable, "-m", *stage_args]
    print(f"\n$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=MODEL_ROOT)
    if result.returncode != 0:
        sys.exit(f"stage failed: {' '.join(stage_args)} (exit {result.returncode})")


def main():
    ap = argparse.ArgumentParser(description="Run fetch -> features -> train end to end.")
    ap.add_argument("--routine", default=None, help="restrict to one routine (default: all)")
    ap.add_argument("--label", default="any", choices=["human", "synthetic", "any"])
    args = ap.parse_args()

    tag = args.routine or "all"
    DATA.mkdir(parents=True, exist_ok=True)
    raw = DATA / f"{tag}.parquet"
    feats = DATA / f"{tag}_features.parquet"
    subj = DATA / f"{tag}_subjects.parquet"

    fetch_args = ["src.common.fetch_telemetry", "--label", args.label, "--out", str(raw)]
    if args.routine:
        fetch_args += ["--routine", args.routine]
    _run(fetch_args)
    _run(["src.common.features", "--in", str(raw), "--out", str(feats), "--subject-out", str(subj)])
    _run(["src.bot_detection.train", "--in", str(feats)])
    print("\nPipeline complete. Model + metrics saved under model/models/.")


if __name__ == "__main__":
    main()
