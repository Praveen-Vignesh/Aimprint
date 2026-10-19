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

    def accept(self, template: dict, verify_seg_df: pd.DataFrame) -> bool:
        """True = same person (distance below the EER threshold). A research
        signal, NOT a standalone auth decision — see the module/README caveats."""
        return self.distance(template, verify_seg_df) < self.threshold
