"""Biometric verification: score a verify session against a stored template and
decide same-person / different-person.

The decision is a diagonal-Mahalanobis distance from the verify session's mean
feature vector to the template mean, standardized by template variance. Lower =
more likely the same person. A verifier carries only the feature order + the
operating threshold (chosen at EER during training); the per-subject templates
live in the DB, never in the artifact.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from src.biometric.template import BIOMETRIC_FEATURES, session_vector

# A session is a "match" only at or above this match percent. The percent is
# anchored on the artifact's own EER threshold T (see match_percent): 50% is the
# EER boundary, 100% is distance 0, so 80% means distance <= 0.4*T.
#
# Why 80 and not the EER boundary (50) or 90, measured 2026-10-21 with the
# a4fea2d4 verifier:
#   * Strangers (90 cross-person trials, 10 enrolled subjects): a cutoff of 50
#     accepted 76% of them, 70 -> 28%, 80 -> 10%, 85 -> 2%, 90 -> 0%.
#   * Genuine (only 6 held-out verify trials, 3 subjects): 80 passes 3 of 6,
#     85 passes 2, 90 passes 1 — real players would rarely see a match at 90.
# 80 is the compromise: it cuts stranger acceptance from 76% to 10% while about
# half of genuine sessions still pass. The genuine side is far too small to
# measure a real false-reject rate, so this is a demo operating point, not a
# validated one. Revisit when more subjects have >=2 sessions; raise toward 85
# for fewer strangers at the cost of more genuine rejections. Editing it needs a
# service redeploy, not a retrain or artifact upload — it is code, not part of
# the pickled verifier.
MATCH_PERCENT_THRESHOLD = 80.0


def match_percent(distance: float, threshold: float) -> int:
    """Distance -> 0..100 similarity, anchored on the EER threshold: distance 0
    is 100, distance == threshold is 50, distance >= 2*threshold is 0. An
    unusable distance or threshold (inf, NaN, non-positive) is 0, never a pass."""
    if not (np.isfinite(distance) and np.isfinite(threshold)) or threshold <= 0:
        return 0
    pct = 100.0 * (1.0 - distance / (2.0 * threshold))
    return int(round(max(0.0, min(100.0, pct))))


def template_distance(template: dict, verify_seg_df: pd.DataFrame) -> float:
    """Standardized distance from a verify session to a template. Averages the
    per-feature squared z-distance over the features defined on BOTH sides —
    NaN features (e.g. click-only on a no-click session) are skipped, never
    imputed, so a missing feature neither helps nor hurts."""
    features = template["features"]
    means = np.array([np.nan if m is None else m for m in template["means"]], dtype=float)
    varis = np.array(template["variances"], dtype=float)
    vec = session_vector(verify_seg_df, features)

    defined = np.isfinite(vec) & np.isfinite(means) & np.isfinite(varis) & (varis > 0)
    if not defined.any():
        return float("inf")  # nothing comparable → reject
    z2 = ((vec[defined] - means[defined]) ** 2) / varis[defined]
    return float(np.sqrt(np.mean(z2)))


@dataclass
class BiometricVerifier:
    """The persisted biometric artifact (registry model_type='biometric'). Holds
    the feature order, the EER-operating threshold, and metadata — NOT the
    templates (those are per-subject rows in biometric_templates)."""
    features: list[str] = field(default_factory=lambda: list(BIOMETRIC_FEATURES))
    threshold: float = float("inf")
    features_version: int = 1
    model_version: str = ""
    meta: dict = field(default_factory=dict)

    def distance(self, template: dict, verify_seg_df: pd.DataFrame) -> float:
        return template_distance(template, verify_seg_df)

    def match_percent(self, distance: float) -> int:
        return match_percent(distance, self.threshold)

    def accept_distance(self, distance: float) -> bool:
        """True = same person: match percent at or above MATCH_PERCENT_THRESHOLD.
        The single accept rule — serving and offline checks both go through it.
        A research signal, NOT a standalone auth decision."""
        return self.match_percent(distance) >= MATCH_PERCENT_THRESHOLD

    def accept(self, template: dict, verify_seg_df: pd.DataFrame) -> bool:
        return self.accept_distance(self.distance(template, verify_seg_df))
