"""Unit tests for the archive job's safety-critical pure logic — no DB, no
Storage, no live connection. Covers the verify-before-delete gate (the one rule
that makes archive-then-prune safe for unregenerable data), the v1 decode on the
way out, the content fingerprint, and the lag parser. The live I/O
(archive_one/main) is deliberately NOT exercised here. Run from model/:

    python -m tests.test_archive
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src import archive_telemetry as A  # noqa: E402

META = {
    "session_id": "sess-1", "subject_id": "subj-1",
    "routine": "flick", "difficulty": "medium", "sampling_version": 1,
}


def _encoded_segment(idx: int) -> dict:
    """One wire-format segment as src/telemetry.js writes it: columnar trajectory
    with tx/ty/tz OMITTED (static flick), input_events delta-encoded in integer
    tenths of a millisecond."""
    n = 10
    traj = {
        "t": list(range(0, n * 16, 16)), "dx": [1] * n, "dy": [0] * n,
        "yaw": [round(0.01 * i, 5) for i in range(n)], "pitch": [0.0] * n,
        "on": [0] * (n - 1) + [1],
    }
    tenths = [i * 10 for i in range(12)]  # decode -> 0,1,2,... ms
    dt = [0] + [tenths[i] - tenths[i - 1] for i in range(1, len(tenths))]
    inputs = {"t0": tenths[0], "dt": dt, "dx": [1] * 12, "dy": [0] * 12}
    return {
        "segment_index": idx, "outcome": "hit", "started_at_ms": idx * 1000,
        "target_distance": 8.0, "time_to_click_ms": 220, "dwell_ms": 70,
        "click_offset_x": 0.01, "click_offset_y": -0.01, "target_count": 1,
        "engaged_index": 0, "frame_count": n, "event_count": 12,
        "duration_ms": (n - 1) * 16,
        "targets": [{"x": 1.0, "y": 0.0, "z": -10.0, "r": 0.5}],
        "trajectory": traj, "input_events": inputs,
    }


def _rows(n=5):
    return [_encoded_segment(i) for i in range(n)]


def test_parse_lag():
    assert A.parse_lag("7d").days == 7
    assert A.parse_lag("24h").total_seconds() == 24 * 3600
    assert A.parse_lag("30m").total_seconds() == 30 * 60
    assert A.parse_lag("0d").total_seconds() == 0
    for bad in ["", "7", "7x", "d", "-1d"]:
        try:
            A.parse_lag(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"parse_lag({bad!r}) should have raised")


def test_partition_path():
    p = A.partition_path(1, "flick", "abc")
    assert p == "segments/sampling_version=1/routine=flick/session_id=abc.parquet"


def test_decode_carries_subject_not_label():
    df = A.decode_session_segments(_rows(3), META)
    assert len(df) == 3
    assert (df["subject_id"] == "subj-1").all()
    # The archive stores subject_id ONLY — never a resolved label (retroactive
    # labelling depends on joining kind/cohort live at train time).
    for forbidden in ["is_human", "subject_kind", "kind", "cohort"]:
        assert forbidden not in df.columns, f"{forbidden} must not be archived"


def test_decode_v1_on_the_way_out():
    df = A.decode_session_segments(_rows(1), META)
    traj = json.loads(df["trajectory"].iloc[0])
    ev = json.loads(df["input_events"].iloc[0])
    # input_events decoded to ABSOLUTE ms (0,1,2,...) from the delta form.
    assert ev["t_ms"][:3] == [0.0, 1.0, 2.0]
    # Static flick: tx/ty/tz reconstructed from the targets snapshot at engaged_index.
    assert traj["tx"] == [1.0] * 10
    assert traj["tz"] == [-10.0] * 10


def test_content_sha256_order_independent():
    pairs = [("s", 2), ("s", 0), ("s", 1)]
    assert A.content_sha256(pairs) == A.content_sha256(list(reversed(pairs)))
    # A different segment set must hash differently.
    assert A.content_sha256(pairs) != A.content_sha256([("s", 0), ("s", 1)])


def test_verify_parquet_gate():
    rows = _rows(5)
    df = A.decode_session_segments(rows, META)
    db_pairs = [(META["session_id"], r["segment_index"]) for r in rows]
    db_count, db_sha = len(db_pairs), A.content_sha256(db_pairs)

    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "s.parquet"
        df.to_parquet(path, engine="pyarrow", compression="zstd", index=False)

        # Correct count + sha -> gate opens.
        ok, got_count, got_sha = A.verify_parquet(path, db_count, db_sha)
        assert ok and got_count == 5 and got_sha == db_sha

        # Wrong expected count -> gate stays shut (would abort the delete).
        ok_c, _, _ = A.verify_parquet(path, db_count + 1, db_sha)
        assert not ok_c

        # Tampered fingerprint -> gate stays shut.
        ok_s, _, _ = A.verify_parquet(path, db_count, "deadbeef")
        assert not ok_s

        # A Parquet MISSING a row (incomplete write) must fail the count check
        # against the database's true count — the real no-data-lost scenario.
        short = df.iloc[:-1]
        short_path = Path(d) / "short.parquet"
        short.to_parquet(short_path, engine="pyarrow", compression="zstd", index=False)
        ok_short, got_short, _ = A.verify_parquet(short_path, db_count, db_sha)
        assert not ok_short and got_short == 4


def run_all():
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"{len(tests)} archive tests passed")


if __name__ == "__main__":
    run_all()
