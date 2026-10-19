"""End-to-end smoke test on a synthetic 4-subject frame — no DB, no real data.
Proves features -> detector -> evaluate -> nested CV all run and return sane
shapes, and that the nested search is grouped (no row-level leak). Run from
model/:

    python -m tests.test_pipeline_smoke
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.bot_detection import evaluate, train  # noqa: E402
from src.bot_detection.detector import HierarchicalBotDetector, labels_to_is_bot  # noqa: E402
from src.common.features import FEATURE_COLUMNS, HARDWARE_COLUMNS, build_segment_features  # noqa: E402


def _segment(subject, idx, is_bot, rng):
    n = 25
    t = list(range(0, n * 16, 16))
    if is_bot:
        # Smooth linear ramp, tiny noise: one submovement, near-straight.
        yaw = np.linspace(0, 0.4, n) + rng.normal(0, 0.0005, n)
        pitch = np.linspace(0, -0.15, n) + rng.normal(0, 0.0005, n)
        dxs = [1] * n
    else:
        # Ballistic + correction, more jitter: multiple submovements, reversals.
        ramp = np.concatenate([np.linspace(0, 0.45, n // 2), np.linspace(0.45, 0.4, n - n // 2)])
        yaw = ramp + rng.normal(0, 0.004, n)
        pitch = np.linspace(0, -0.15, n) + rng.normal(0, 0.004, n)
        dxs = list(rng.integers(-2, 3, n))
    traj = {"t": t, "dx": [int(x) for x in dxs], "dy": [0] * n,
            "yaw": list(yaw), "pitch": list(pitch), "on": [0] * (n - 1) + [1]}
    ev_n = 40
    if is_bot:
        edx = [1] * ev_n
    else:
        edx = list(int(x) for x in rng.integers(-2, 3, ev_n))
    inputs = {"t_ms": [i * 1.0 for i in range(ev_n)], "dx": edx, "dy": [0] * ev_n}
    outcome = "hit" if idx % 3 else "miss"
    return {
        "segment_id": f"{subject}-{idx}", "session_id": f"{subject}-s{idx // 6}",
        "subject_id": subject, "is_human": (not is_bot),
        "subject_kind": "synthetic" if is_bot else "human",
        "subject_cohort": "bot_snap" if is_bot else "friends_batch_1",
        "routine": "flick", "difficulty": "medium", "outcome": outcome,
        "trajectory": traj, "input_events": inputs,
        "targets": [{"x": 1.0, "y": 0.0, "z": -10.0, "r": 0.5}], "engaged_index": 0,
        "target_distance": 8.0 + (idx % 5),
        "time_to_click_ms": 200 + int(rng.integers(0, 120)),
        "dwell_ms": 60 + int(rng.integers(0, 60)),
        "click_offset_x": float(rng.normal(0, 0.03)),
        "click_offset_y": float(rng.normal(0, 0.03)),
        "dpi": 800, "sens": 0.4, "cm_per_360": 40.8,
    }


def _frame():
    rng = np.random.default_rng(1)
    rows = []
    # 2 human + 2 bot subjects, 12 segments each.
    for s, is_bot in [("human_a", False), ("human_b", False), ("bot_a", True), ("bot_b", True)]:
        for i in range(12):
            rows.append(_segment(s, i, is_bot, rng))
    return pd.DataFrame(rows)


def test_features_build():
    feats = build_segment_features(_frame())
    assert len(feats) == 48
    assert set(FEATURE_COLUMNS).issubset(feats.columns)


def test_detector_round_trip():
    feats = build_segment_features(_frame())
    X = feats[FEATURE_COLUMNS].to_numpy(dtype=float)
    y = labels_to_is_bot(feats["is_human"]).to_numpy()
    est = train._hgb()
    est.fit(X, y)
    det = HierarchicalBotDetector(est, FEATURE_COLUMNS)
    pred = det.subject_predict(feats)
    assert set(pred["subject_id"]) == {"human_a", "human_b", "bot_a", "bot_b"}
    assert ((pred["bot_probability"] >= 0) & (pred["bot_probability"] <= 1)).all()
    assert set(pred["predicted_label"]).issubset({"human", "synthetic"})


def test_subject_cv_reports_human_fp_rate():
    feats = build_segment_features(_frame())
    features = FEATURE_COLUMNS + [c for c in HARDWARE_COLUMNS if c in feats.columns]
    res = evaluate.subject_cv(feats, train._hgb, features, n_splits=4)
    assert "skipped" not in res, res
    assert "human_false_positive_rate" in res
    assert res["n_subjects_scored"] == 4


def test_nested_score_runs_grouped():
    feats = build_segment_features(_frame())
    features = FEATURE_COLUMNS + [c for c in HARDWARE_COLUMNS if c in feats.columns]
    make_est, grid = train.CANDIDATES["hgb"]
    res = train._nested_subject_score(make_est, grid, feats, features, outer_splits=4)
    assert res is not None and "balanced_accuracy" in res
    # Leak guard: inner splits never exceed the training-group count.
    assert train._inner_splits(1) is None
    assert train._inner_splits(3) == 3
    assert train._inner_splits(5) == 3


def run_all():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} pipeline smoke tests passed")


if __name__ == "__main__":
    run_all()
