"""Fixture tests for features.py — no DB, no real data. Checks the two
load-bearing rules: click-only fields stay NaN on non-click rows (never
imputed), and a single-frame segment does not crash. Run from model/:

    python -m tests.test_features
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.common.features import (  # noqa: E402
    CLICK_ONLY_COLUMNS, FEATURE_COLUMNS, build_segment_features,
)


def _traj(n, moving=False):
    t = list(range(0, n * 16, 16))
    yaw = list(np.linspace(0.0, 0.3, n) + np.random.default_rng(0).normal(0, 0.002, n))
    pitch = list(np.linspace(0.0, -0.1, n))
    col = {"t": t, "dx": [1] * n, "dy": [0] * n, "yaw": yaw, "pitch": pitch,
           "on": [0] * (n - 1) + [1]}
    if moving:
        col["tx"] = [1.0] * n
        col["ty"] = [0.0] * n
        col["tz"] = [-10.0] * n
    return col


def _inputs(n):
    return {"t_ms": [i * 1.0 for i in range(n)], "dx": [1, -1] * (n // 2), "dy": [0] * n}


def _row(outcome, click=True, n_frames=30):
    return {
        "segment_id": f"seg-{outcome}", "session_id": "sess-1", "subject_id": "subj-1",
        "is_human": True, "subject_kind": "human", "subject_cohort": "friends_batch_1",
        "routine": "flick", "difficulty": "medium", "outcome": outcome,
        "trajectory": _traj(n_frames), "input_events": _inputs(40),
        "targets": [{"x": 1.0, "y": 0.0, "z": -10.0, "r": 0.5}], "engaged_index": 0,
        "target_distance": 10.0,
        "time_to_click_ms": 250 if click else None,
        "dwell_ms": 80 if click else None,
        "click_offset_x": 0.03 if click else None,
        "click_offset_y": -0.02 if click else None,
        "dpi": 800, "sens": 0.4, "cm_per_360": 40.8,
    }


def test_click_only_fields_nan_on_non_click_rows():
    df = pd.DataFrame([
        _row("hit", click=True), _row("miss", click=True),
        _row("timeout", click=False), _row("track", click=False),
    ])
    out = build_segment_features(df).reset_index(drop=True)
    # hit/miss carry click fields; timeout/track must be NaN (never imputed).
    for col in CLICK_ONLY_COLUMNS + ["radial_offset"]:
        assert not math.isnan(out.loc[0, col]), f"{col} should be present on hit"
        assert not math.isnan(out.loc[1, col]), f"{col} should be present on miss"
        assert math.isnan(out.loc[2, col]), f"{col} must be NaN on timeout"
        assert math.isnan(out.loc[3, col]), f"{col} must be NaN on track"


def test_single_frame_segment_does_not_crash():
    df = pd.DataFrame([_row("hit", click=True, n_frames=1)])
    out = build_segment_features(df)
    # Diff-based features are undefined on one frame → NaN, not an exception.
    assert math.isnan(out.loc[0, "peak_angular_speed"])
    assert math.isnan(out.loc[0, "submovement_count"]) or out.loc[0, "submovement_count"] >= 0


def test_all_feature_columns_present():
    df = pd.DataFrame([_row("hit"), _row("miss")])
    out = build_segment_features(df)
    for col in FEATURE_COLUMNS:
        assert col in out.columns, f"missing feature column {col}"


def run_all():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} feature tests passed")


if __name__ == "__main__":
    run_all()
