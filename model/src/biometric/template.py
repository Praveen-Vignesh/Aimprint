"""Per-subject biometric template: the signature built from a subject's ENROL
sessions. Reuses the same per-segment features as the bot detector, but on the
DPI-independent / motor subset only — a person's biometric is their aim motion,
NOT their hardware (hardware identifies a rig, not a person, and would leak
device identity into what is supposed to be a behavioural signature).

A template is a per-feature mean + variance over the subject's enrol segments
(diagonal Mahalanobis — a full covariance needs more samples than features,
which the campaign does not have). Stored as plain JSON so it round-trips into
the biometric_templates table unchanged.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.common.features import FEATURE_COLUMNS, HARDWARE_COLUMNS

# Biometric features = the motor signal, hardware EXCLUDED on purpose.
BIOMETRIC_FEATURES = [c for c in FEATURE_COLUMNS if c not in HARDWARE_COLUMNS]

# Variance floor so a near-constant feature cannot blow up the Mahalanobis term
# (divide-by-tiny). Chosen small relative to standardized feature scales.
VAR_FLOOR = 1e-6


def session_vector(seg_df: pd.DataFrame, features: list[str] = BIOMETRIC_FEATURES) -> np.ndarray:
    """Reduce a set of segments (one session, or several) to one feature vector:
    the per-feature nanmean. NaN where a feature never registered (e.g. no click
    segments), which the distance step skips rather than imputes."""
    with np.errstate(invalid="ignore"):
        return np.nanmean(seg_df[features].to_numpy(dtype=float), axis=0)


def build_template(enrol_seg_df: pd.DataFrame, features: list[str] = BIOMETRIC_FEATURES,
                   features_version: int = 1) -> dict:
    """Mean + variance per feature over the subject's enrol segments."""
    X = enrol_seg_df[features].to_numpy(dtype=float)
    means = np.nanmean(X, axis=0)
    varis = np.nanvar(X, axis=0)
    varis = np.where(np.isfinite(varis) & (varis > VAR_FLOOR), varis, VAR_FLOOR)
    n_sessions = int(enrol_seg_df["session_id"].nunique()) if "session_id" in enrol_seg_df else 0
    return {
        "features": list(features),
        "means": [None if not np.isfinite(m) else float(m) for m in means],
        "variances": [float(v) for v in varis],
        "n_enrol_sessions": n_sessions,
        "n_enrol_segments": int(len(enrol_seg_df)),
        "features_version": features_version,
    }
