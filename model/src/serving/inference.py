"""The single reusable application surface for both models — pure functions over
raw (decoded) segments, importable with no server. app.py is a thin HTTP wrapper
on top of this; evaluation uses the same operations.

Model artifacts are loaded from the registry (files). Biometric templates are
read from the DB with the service key (templates are never client-readable).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.common import fetch_telemetry, registry  # noqa: E402
from src.common.codec import decode_segment  # noqa: E402
from src.common.features import build_segment_features  # noqa: E402

TEMPLATES_TABLE = "biometric_templates"


def _decoded_frame(raw_segments: list[dict] | pd.DataFrame) -> pd.DataFrame:
    """Turn raw browser/DB segments into the decoded frame build_segment_features
    expects. This is the step the endpoints were missing: the browser sends the
    sampling_version=1 WIRE shape (delta-encoded input_events, columnar
    trajectory with tx/ty/tz omitted for static routines), identical to a DB row,
    and it must be run through codec.decode_segment before any feature is read —
    exactly as fetch_telemetry does for the training pull.

    A DataFrame already carrying decoded frames (the evaluation/test path) is
    passed straight through: a decoded trajectory is a dict with a float 't_ms'
    in input_events and no top-level t0/dt, so decoding again would fail. We key
    off the wire marker instead — raw input_events carry 't0'/'dt'.

    sampling_version lives on the sessions row, not the segment, so a browser
    segment omits it; default it to 1 here (decode_segment still refuses any
    other value a caller sets explicitly).
    """
    if isinstance(raw_segments, pd.DataFrame):
        return raw_segments
    decoded_rows = []
    for seg in raw_segments:
        row = dict(seg)
        row.setdefault("sampling_version", 1)
        decoded = decode_segment(row)
        row["trajectory"] = decoded["trajectory"]
        row["input_events"] = decoded["input_events"]
        decoded_rows.append(row)
    return pd.DataFrame(decoded_rows)


def load_bot_detector(version: str | None = None):
    return registry.load("bot_detection", version)


def load_biometric(version: str | None = None):
    return registry.load("biometric", version)


def score_bot(detector, raw_segments: list[dict] | pd.DataFrame,
              subject_id: str | None = None) -> list[dict]:
    """Raw wire-format segments in → per-subject bot verdicts out. The browser's
    segments have no subject_id (it is session-scoped, not segment-scoped), so
    the caller passes it and it is stamped on before the subject-level groupby.
    The offline path already carries subject_id from the training view and omits
    it here."""
    frame = _decoded_frame(raw_segments)
    if subject_id is not None and "subject_id" not in frame.columns:
        frame = frame.copy()
        frame["subject_id"] = subject_id
    feats = build_segment_features(frame)
    return detector.subject_predict(feats).to_dict(orient="records")


def get_template(subject_id: str) -> dict | None:
    """Fetch a subject's stored template (service key — the table is not
    client-readable). None if the subject has not been enrolled."""
    client = fetch_telemetry._client()
    rows = (
        client.table(TEMPLATES_TABLE).select("signature")
        .eq("subject_id", subject_id).limit(1).execute().data
    )
    return rows[0]["signature"] if rows else None


def verify(verifier, template: dict, raw_segments: list[dict] | pd.DataFrame) -> dict:
    """Distance of a verify session to a claimed template → accept/reject. A
    SECONDARY signal only — never a standalone auth decision."""
    feats = build_segment_features(_decoded_frame(raw_segments))
    distance = verifier.distance(template, feats)
    return {
        "distance": distance,
        "accept": bool(distance < verifier.threshold),
        "threshold": verifier.threshold,
        "model_version": verifier.model_version,
    }
