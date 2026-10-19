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
from src.common.features import build_segment_features  # noqa: E402

TEMPLATES_TABLE = "biometric_templates"


def load_bot_detector(version: str | None = None):
    return registry.load("bot_detection", version)


def load_biometric(version: str | None = None):
    return registry.load("biometric", version)


def score_bot(detector, raw_segments: list[dict] | pd.DataFrame) -> list[dict]:
    """Raw decoded segments in → per-subject bot verdicts out."""
    df = raw_segments if isinstance(raw_segments, pd.DataFrame) else pd.DataFrame(raw_segments)
    feats = build_segment_features(df)
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
    df = raw_segments if isinstance(raw_segments, pd.DataFrame) else pd.DataFrame(raw_segments)
    feats = build_segment_features(df)
    distance = verifier.distance(template, feats)
    return {
        "distance": distance,
        "accept": bool(distance < verifier.threshold),
        "threshold": verifier.threshold,
        "model_version": verifier.model_version,
    }
