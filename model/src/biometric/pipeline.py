"""Thin orchestrator for the biometric path: fetch human subjects -> features ->
calibrate verifier (EER) -> enrol templates. Run from model/:

    python -m src.biometric.pipeline

Each stage is runnable alone; this chains them. Enrolment writes to the DB, so
it is skipped on --no-enrol (calibrate only).
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
    ap = argparse.ArgumentParser(description="Run fetch -> features -> calibrate -> enrol.")
    ap.add_argument("--enrol-sessions", type=int, default=3)
    ap.add_argument("--no-enrol", action="store_true", help="calibrate only, skip DB writes")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    raw = DATA / "human.parquet"
    feats = DATA / "human_features.parquet"

    _run(["src.common.fetch_telemetry", "--label", "human", "--out", str(raw)])
    _run(["src.common.features", "--in", str(raw), "--out", str(feats)])
    _run(["src.biometric.train_biometric", "--in", str(feats),
          "--enrol-sessions", str(args.enrol_sessions)])
    if not args.no_enrol:
        _run(["src.biometric.enrol", "--enrol-sessions", str(args.enrol_sessions)])
    print("\nBiometric pipeline complete.")


if __name__ == "__main__":
    main()
