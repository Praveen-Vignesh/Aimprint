"""Round-trip guard for model/src/codec.py against the exact encoder in
src/telemetry.js. This is "the whole safety margin" DESIGN.md asks for: the
two _js_encode_* helpers below are a deliberate line-for-line mirror of
inputsToColumnar() / toColumnar() in src/telemetry.js, not a reinvention —
if telemetry.js's encoding ever changes, this file's encoder must change
with it, by hand, so a drift is caught here before it corrupts real data.

Dependency-free on purpose (no pytest in requirements.txt): run directly
with `python -m tests.test_codec` from model/.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.codec import decode_input_events, decode_segment, require_v1  # noqa: E402


def _js_encode_input_events(inputs: list[dict]) -> dict:
    """Mirrors inputsToColumnar() in src/telemetry.js. `inputs` is a list of
    {t, dx, dy} where t is already an integer tenth-of-ms (recordInput's job,
    not this function's — matching the JS split)."""
    n = len(inputs)
    if n == 0:
        return {"t0": 0, "dt": [], "dx": [], "dy": []}

    t0 = inputs[0]["t"]
    dt, dx, dy = [], [], []
    prev = t0
    for item in inputs:
        dt.append(item["t"] - prev)  # dt[0] == 0
        prev = item["t"]
        dx.append(item["dx"])
        dy.append(item["dy"])
    return {"t0": t0, "dt": dt, "dx": dx, "dy": dy}


def _js_encode_trajectory(frames: list[dict], moves_targets: bool) -> dict:
    """Mirrors toColumnar() in src/telemetry.js."""
    columns = {
        "t": [f["t"] for f in frames],
        "dx": [f["dx"] for f in frames],
        "dy": [f["dy"] for f in frames],
        "yaw": [f["yaw"] for f in frames],
        "pitch": [f["pitch"] for f in frames],
        "on": [f["on"] for f in frames],
    }
    if moves_targets:
        columns["tx"] = [f["tx"] for f in frames]
        columns["ty"] = [f["ty"] for f in frames]
        columns["tz"] = [f["tz"] for f in frames]
    return columns


def test_input_events_round_trip_exact():
    # Raw pointer samples at ~1kHz, timestamps already rounded to tenths of a
    # ms (recordInput's job): irregular gaps on purpose, like a real mouse.
    raw = [
        {"t": 1000, "dx": 3, "dy": -1},
        {"t": 1011, "dx": 2, "dy": 0},
        {"t": 1019, "dx": -4, "dy": 2},
        {"t": 1030, "dx": 0, "dy": 0},
        {"t": 2554, "dx": 7, "dy": -3},  # a big gap, like a backgrounded tab
    ]
    encoded = _js_encode_input_events(raw)
    assert encoded["dt"][0] == 0

    decoded = decode_input_events(encoded)
    expected_t_ms = [item["t"] / 10.0 for item in raw]
    assert decoded["t_ms"] == expected_t_ms, (decoded["t_ms"], expected_t_ms)
    assert decoded["dx"] == [item["dx"] for item in raw]
    assert decoded["dy"] == [item["dy"] for item in raw]


def test_input_events_long_stream_no_drift():
    # A float cumsum over hundreds of terms is exactly the failure mode this
    # guards against; 500 irregular steps is enough to expose it if present.
    raw = []
    t = 0
    for i in range(500):
        t += 7 + (i % 5)  # irregular step sizes, never a clean multiple of 10
        raw.append({"t": t, "dx": i % 3 - 1, "dy": (i * 2) % 5 - 2})

    encoded = _js_encode_input_events(raw)
    decoded = decode_input_events(encoded)
    expected_t_ms = [item["t"] / 10.0 for item in raw]
    assert decoded["t_ms"] == expected_t_ms


def test_input_events_none_passthrough():
    assert decode_input_events(None) is None


def test_trajectory_static_routine_fills_from_targets():
    frames = [
        {"t": 0, "dx": 0, "dy": 0, "yaw": 0.1, "pitch": -0.02, "on": 0},
        {"t": 16, "dx": 1, "dy": 1, "yaw": 0.11, "pitch": -0.01, "on": 1},
    ]
    encoded = _js_encode_trajectory(frames, moves_targets=False)
    assert "tx" not in encoded  # the omission under test

    targets = [{"x": 1.0, "y": 2.0, "z": -10.0, "r": 0.5}]
    row = {
        "sampling_version": 1,
        "trajectory": encoded,
        "input_events": None,
        "targets": targets,
        "engaged_index": 0,
    }
    decoded = decode_segment(row)["trajectory"]
    assert decoded["tx"] == [1.0, 1.0]
    assert decoded["ty"] == [2.0, 2.0]
    assert decoded["tz"] == [-10.0, -10.0]
    assert decoded["t"] == [0, 16]
    assert decoded["yaw"] == [0.1, 0.11]


def test_trajectory_moving_routine_keeps_per_frame_positions():
    frames = [
        {"t": 0, "dx": 0, "dy": 0, "yaw": 0.0, "pitch": 0.0, "on": 0, "tx": 1.0, "ty": 0.0, "tz": -10.0},
        {"t": 16, "dx": 2, "dy": 0, "yaw": 0.01, "pitch": 0.0, "on": 1, "tx": 1.2, "ty": 0.0, "tz": -10.0},
    ]
    encoded = _js_encode_trajectory(frames, moves_targets=True)
    row = {
        "sampling_version": 1,
        "trajectory": encoded,
        "input_events": None,
        "targets": None,
        "engaged_index": None,
    }
    decoded = decode_segment(row)["trajectory"]
    assert decoded["tx"] == [1.0, 1.2]


def test_require_v1_rejects_other_versions():
    try:
        require_v1(4)
    except ValueError:
        return
    raise AssertionError("require_v1(4) should have raised")


def run_all():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for test in tests:
        test()
        print(f"  ok  {test.__name__}")
    print(f"{len(tests)} codec tests passed")


if __name__ == "__main__":
    run_all()
