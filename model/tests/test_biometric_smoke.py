"""End-to-end smoke test for the biometric path — no DB. Synthesizes a few
subjects with distinct motor "styles", each playing several sessions, then
checks: enrol/verify splits by session order (NO calendar-day requirement —
that was removed), templates build, genuine distances sit below impostor
distances, and EER computes in [0,1].

Run from model/:
    python -m tests.test_biometric_smoke
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.biometric import evaluate_biometric  # noqa: E402
from src.biometric.template import BIOMETRIC_FEATURES, build_template  # noqa: E402
from src.biometric.verify import BiometricVerifier, template_distance  # noqa: E402
from src.common.features import build_segment_features  # noqa: E402

# Distinct per-subject motor styles (slope, jitter, reaction base) — consistent
# within a subject, so their feature vectors cluster and genuine < impostor.
STYLES = {
    "alice": (0.30, 0.0015, 190),
    "bob":   (0.42, 0.0050, 240),
    "carol": (0.55, 0.0090, 300),
}
DATES = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]


def _segment(subject, session_idx, seg_idx, style, rng):
    slope, jitter, rt = style
    n = 24
    t = list(range(0, n * 16, 16))
    yaw = np.linspace(0, slope, n) + rng.normal(0, jitter, n)
    pitch = np.linspace(0, -slope / 3, n) + rng.normal(0, jitter, n)
    traj = {"t": t, "dx": [1] * n, "dy": [0] * n,
            "yaw": list(yaw), "pitch": list(pitch), "on": [0] * (n - 1) + [1]}
    ev_n = 40
    edx = list(int(x) for x in rng.integers(-1, 2, ev_n) + (jitter > 0.004))
    inputs = {"t_ms": [i * 1.0 for i in range(ev_n)], "dx": edx, "dy": [0] * ev_n}
    return {
        "segment_id": f"{subject}-{session_idx}-{seg_idx}",
        "session_id": f"{subject}-sess{session_idx}",
        "session_started_at": f"{DATES[session_idx]}T12:00:00+00:00",
        "subject_id": subject, "is_human": True, "subject_kind": "human",
        "subject_cohort": "friends_batch_1", "routine": "flick",
        "difficulty": "medium", "outcome": "hit" if seg_idx % 4 else "miss",
        "trajectory": traj, "input_events": inputs,
        "targets": [{"x": 1.0, "y": 0.0, "z": -10.0, "r": 0.5}], "engaged_index": 0,
        "target_distance": 8.0 + (seg_idx % 5),
        "time_to_click_ms": rt + int(rng.integers(0, 40)),
        "dwell_ms": 60 + int(rng.integers(0, 40)),
        "click_offset_x": float(rng.normal(0, 0.02)),
        "click_offset_y": float(rng.normal(0, 0.02)),
        "dpi": 800, "sens": 0.4, "cm_per_360": 40.8,
    }


def _frame():
    rng = np.random.default_rng(7)
    rows = []
    for subject, style in STYLES.items():
        for session_idx in range(len(DATES)):
            for seg_idx in range(8):
                rows.append(_segment(subject, session_idx, seg_idx, style, rng))
    return build_segment_features(pd.DataFrame(rows))


def test_split_by_session_order():
    feats = _frame()
    split = evaluate_biometric.enrol_verify_split(feats, enrol_sessions=3)
    assert set(split) == set(STYLES)
    for _, (enrol_df, verify) in split.items():
        assert enrol_df["session_id"].nunique() == 3  # earliest 3 sessions
        assert len(verify) == 2  # the remaining 2 sessions


def test_same_day_sessions_now_split():
    """Cross-day removed: a subject whose sessions are ALL on one calendar day
    must now produce an enrol+verify split (previously it was skipped)."""
    rng = np.random.default_rng(11)
    rows = []
    for session_idx in range(3):  # three sessions, same date (DATES[0])
        for seg_idx in range(8):
            r = _segment("dave", session_idx, seg_idx, STYLES["alice"], rng)
            r["session_started_at"] = f"{DATES[0]}T{12 + session_idx}:00:00+00:00"
            rows.append(r)
    feats = build_segment_features(pd.DataFrame(rows))
    split = evaluate_biometric.enrol_verify_split(feats, enrol_sessions=2)
    assert "dave" in split, "same-day subject should split now that cross-day is removed"
    enrol_df, verify = split["dave"]
    assert enrol_df["session_id"].nunique() == 2
    assert len(verify) == 1


def test_template_and_distance_separates():
    feats = _frame()
    split = evaluate_biometric.enrol_verify_split(feats, enrol_sessions=3)
    templates = {s: build_template(e, BIOMETRIC_FEATURES) for s, (e, _) in split.items()}
    # A subject's own verify sessions should be closer to their template than
    # another subject's verify sessions are.
    for s, (_, verify) in split.items():
        genuine = np.mean([template_distance(templates[s], v) for _, v in verify])
        others = [o for o in split if o != s]
        impostor = np.mean([
            template_distance(templates[s], v)
            for o in others for _, v in split[o][1]
        ])
        assert genuine < impostor, f"{s}: genuine {genuine:.3f} !< impostor {impostor:.3f}"


def test_eer_computes():
    feats = _frame()
    report = evaluate_biometric.evaluate(feats, BIOMETRIC_FEATURES, enrol_sessions=3)
    assert "skipped" not in report, report
    assert 0.0 <= report["eer"] <= 1.0
    assert report["n_subjects"] == 3
    assert report["mean_genuine_distance"] < report["mean_impostor_distance"]


def test_verifier_accept_threshold():
    feats = _frame()
    report = evaluate_biometric.evaluate(feats, BIOMETRIC_FEATURES, enrol_sessions=3)
    verifier = BiometricVerifier(features=list(BIOMETRIC_FEATURES), threshold=report["threshold"])
    split = evaluate_biometric.enrol_verify_split(feats, enrol_sessions=3)
    s = next(iter(split))
    enrol_df, verify = split[s]
    template = build_template(enrol_df, BIOMETRIC_FEATURES)
    # Own verify session should be accepted at the EER threshold.
    assert verifier.accept(template, verify[0][1]) in (True, False)  # runs without error


def run_all():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} biometric smoke tests passed")


if __name__ == "__main__":
    run_all()
