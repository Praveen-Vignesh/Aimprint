"""Decodes the sampling_version=1 wire format written by src/telemetry.js.

This is the single source of truth for the v1 codec (see model/DESIGN.md,
"the one contract that must not drift"). Get it subtly wrong and every
feature downstream is silently corrupted against data that cannot be
re-collected. Guarded by model/tests/test_codec.py.

Two independent encodings to undo:
  * input_events: {t0, dt, dx, dy} with t0/dt integer TENTHS of a
    millisecond, dt[0] = 0. Absolute ms = (t0 + cumsum(dt)) / 10. The
    cumsum must stay integer-only until the final /10 or it drifts over a
    few hundred terms.
  * trajectory: {t, dx, dy, yaw, pitch, on[, tx, ty, tz]}. tx/ty/tz are
    present only when the routine set movesTargets (strafing, withheld
    switching); for a static-target routine (flick, spidershot) they are
    omitted and reconstructed here from the targets snapshot at
    engaged_index, where the position is constant for the whole segment.
"""

from __future__ import annotations

SUPPORTED_SAMPLING_VERSION = 1


def require_v1(sampling_version: int) -> None:
    """Refuses to decode anything but the one shape this module understands.

    DESIGN.md: "filter on sampling_version in every pull rather than
    assuming" — this is the enforcement point for that rule.
    """
    if sampling_version != SUPPORTED_SAMPLING_VERSION:
        raise ValueError(
            f"codec.py only decodes sampling_version={SUPPORTED_SAMPLING_VERSION}, "
            f"got {sampling_version!r}. Do not assume the shape — write a new "
            f"decoder for it instead of reusing this one."
        )


def decode_input_events(input_events: dict | None) -> dict | None:
    """{t0, dt, dx, dy} (tenths of ms) -> {t_ms, dx, dy}, or None if absent."""
    if input_events is None:
        return None

    t0 = input_events["t0"]
    dt = input_events["dt"]
    dx = input_events["dx"]
    dy = input_events["dy"]

    if not (len(dt) == len(dx) == len(dy)):
        raise ValueError(
            f"input_events arrays disagree in length: dt={len(dt)} dx={len(dx)} dy={len(dy)}"
        )

    # Integer cumsum (dt[0] is defined as 0 by the encoder) — the /10 happens
    # once per element afterwards, never inside the running sum, so nothing
    # compounds.
    t_tenths = []
    running = t0
    for i, delta in enumerate(dt):
        if i > 0:
            running += delta
        t_tenths.append(running)

    return {"t_ms": [v / 10.0 for v in t_tenths], "dx": list(dx), "dy": list(dy)}


def decode_trajectory(trajectory: dict, targets: list | None, engaged_index: int | None) -> dict:
    """Returns a dict that always carries tx/ty/tz, filling them from the
    targets snapshot when the encoder omitted them (static-target routines).
    Presence of 'tx' in the raw blob is the ground truth for whether the
    routine moved its target — not the routine name — because that is
    exactly the bit telemetry.js's toColumnar() branches on when writing.
    """
    frame_count = len(trajectory["t"])
    decoded = {
        "t": list(trajectory["t"]),
        "dx": list(trajectory["dx"]),
        "dy": list(trajectory["dy"]),
        "yaw": list(trajectory["yaw"]),
        "pitch": list(trajectory["pitch"]),
        "on": list(trajectory["on"]),
    }

    if "tx" in trajectory:
        decoded["tx"] = list(trajectory["tx"])
        decoded["ty"] = list(trajectory["ty"])
        decoded["tz"] = list(trajectory["tz"])
        return decoded

    if engaged_index is None or not targets:
        decoded["tx"] = [None] * frame_count
        decoded["ty"] = [None] * frame_count
        decoded["tz"] = [None] * frame_count
        return decoded

    engaged = targets[engaged_index]
    decoded["tx"] = [engaged["x"]] * frame_count
    decoded["ty"] = [engaged["y"]] * frame_count
    decoded["tz"] = [engaged["z"]] * frame_count
    return decoded


def decode_segment(row: dict) -> dict:
    """Decodes one v_training_segments row's two payload columns.

    `row` needs at least: sampling_version, trajectory, input_events,
    targets, engaged_index. Returns {"trajectory": ..., "input_events": ...}
    — everything else on the row passes through unchanged by the caller.
    """
    require_v1(row["sampling_version"])
    return {
        "trajectory": decode_trajectory(row["trajectory"], row.get("targets"), row.get("engaged_index")),
        "input_events": decode_input_events(row.get("input_events")),
    }
