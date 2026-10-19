"""The serving endpoints receive the sampling_version=1 WIRE shape straight from
the browser (delta-encoded input_events {t0, dt, dx, dy}; columnar trajectory
with tx/ty/tz omitted for static routines; no top-level sampling_version — it
lives on the sessions row). This test proves inference._decoded_frame runs that
wire payload through codec.decode_segment so features come out identical to the
already-decoded path features.py was tested on. Without the decode step the
delta-encoded input_events would be read as raw counts and every tremor/
quantization feature would be silently wrong. Run from model/:

    python -m tests.test_serving_decode
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.common.features import FEATURE_COLUMNS, build_segment_features  # noqa: E402
from src.serving import inference  # noqa: E402

N_FRAMES = 30
N_EVENTS = 48
TARGETS = [{"x": 1.0, "y": 0.0, "z": -10.0, "r": 0.5}]


def _source_streams():
    """Shared ground-truth streams in DECODED units."""
    rng = np.random.default_rng(3)
    yaw = list(np.linspace(0, 0.4, N_FRAMES) + rng.normal(0, 0.004, N_FRAMES))
    pitch = list(np.linspace(0, -0.15, N_FRAMES) + rng.normal(0, 0.004, N_FRAMES))
    frame_t = list(range(0, N_FRAMES * 16, 16))
    on = [0] * (N_FRAMES - 1) + [1]
    # input_events at ~1 kHz: absolute ms = 0,1,2,... and integer device counts.
    ev_t_ms = [float(i) for i in range(N_EVENTS)]
    ev_dx = [int(x) for x in rng.integers(-2, 3, N_EVENTS)]
    ev_dy = [int(x) for x in rng.integers(-2, 3, N_EVENTS)]
    return frame_t, yaw, pitch, on, ev_t_ms, ev_dx, ev_dy


def _common_fields():
    return {
        "segment_id": "s-0", "session_id": "s-sess", "subject_id": "s",
        "is_human": True, "subject_kind": "human", "subject_cohort": "friends_batch_1",
        "routine": "flick", "difficulty": "medium", "outcome": "hit",
        "targets": TARGETS, "engaged_index": 0, "target_distance": 9.0,
        "time_to_click_ms": 240, "dwell_ms": 80,
        "click_offset_x": 0.02, "click_offset_y": -0.01,
        "dpi": 800, "sens": 0.4, "cm_per_360": 40.8,
    }


def _decoded_segment(frame_t, yaw, pitch, on, ev_t_ms, ev_dx, ev_dy):
    """The shape features.py was originally tested against (codec already run)."""
    seg = _common_fields()
    seg["trajectory"] = {
        "t": frame_t, "dx": [1] * N_FRAMES, "dy": [0] * N_FRAMES,
        "yaw": yaw, "pitch": pitch, "on": on,
        # static routine — decode would fill these from the snapshot; features
        # don't read them, carried only to mirror a fully decoded row.
        "tx": [1.0] * N_FRAMES, "ty": [0.0] * N_FRAMES, "tz": [-10.0] * N_FRAMES,
    }
    seg["input_events"] = {"t_ms": ev_t_ms, "dx": ev_dx, "dy": ev_dy}
    return seg


def _encoded_segment(frame_t, yaw, pitch, on, ev_t_ms, ev_dx, ev_dy):
    """Exactly what src/telemetry.js puts on the wire: columnar trajectory with
    tx/ty/tz OMITTED (static routine), input_events delta-encoded as {t0, dt,
    dx, dy} in integer tenths of a millisecond, and NO sampling_version key."""
    tenths = [round(t * 10) for t in ev_t_ms]  # recordInput rounds before delta
    dt = [0] + [tenths[i] - tenths[i - 1] for i in range(1, len(tenths))]
    seg = _common_fields()
    seg["trajectory"] = {
        "t": frame_t, "dx": [1] * N_FRAMES, "dy": [0] * N_FRAMES,
        "yaw": yaw, "pitch": pitch, "on": on,
    }
    seg["input_events"] = {"t0": tenths[0], "dt": dt, "dx": ev_dx, "dy": ev_dy}
    return seg


def test_encoded_matches_decoded():
    streams = _source_streams()
    encoded = _encoded_segment(*streams)
    decoded = _decoded_segment(*streams)

    # Encoded goes through the serving decode step; decoded is already in
    # features.py's expected shape and goes straight in.
    feats_encoded = build_segment_features(inference._decoded_frame([encoded]))
    feats_decoded = build_segment_features(pd.DataFrame([decoded]))

    for col in FEATURE_COLUMNS:
        a = feats_encoded[col].to_numpy(dtype=float)
        b = feats_decoded[col].to_numpy(dtype=float)
        assert np.allclose(a, b, equal_nan=True), (
            f"{col}: encoded {a} != decoded {b} — the wire payload was not "
            f"decoded before feature extraction"
        )


def test_sampling_version_defaulted_and_enforced():
    streams = _source_streams()
    encoded = _encoded_segment(*streams)
    assert "sampling_version" not in encoded  # browser never sends it per-segment
    # Defaults to 1 and decodes without error.
    inference._decoded_frame([encoded])
    # An explicit non-v1 version is still refused by the codec.
    bad = dict(encoded, sampling_version=2)
    try:
        inference._decoded_frame([bad])
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for sampling_version=2")


def test_null_input_events_decode():
    """A session may run without raw capture: buildSegmentPayload sends
    input_events: null. Decode must tolerate it and features stay NaN, not crash."""
    streams = _source_streams()
    encoded = _encoded_segment(*streams)
    encoded["input_events"] = None
    feats = build_segment_features(inference._decoded_frame([encoded]))
    assert len(feats) == 1


def run_all():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} serving decode tests passed")


if __name__ == "__main__":
    run_all()
