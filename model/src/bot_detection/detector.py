"""The hierarchical bot detector: a per-segment probability model plus the
subject-level aggregation that turns many segment scores into one verdict per
person.

Shared by train.py (fits it), evaluate.py (scores held-out subjects), and
score.py (scores unknown subjects). Kept in one place so the segment->subject
aggregation is defined exactly once — if train and score aggregated
differently, the reported accuracy would not match the predictions shipped.

The object is picklable (it holds a fitted sklearn estimator + plain fields),
so registry.py joblib-dumps it directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class HierarchicalBotDetector:
    estimator: object               # fitted sklearn estimator/pipeline on segment features
    features: list[str]             # the exact feature columns it was fit on, in order
    threshold: float = 0.5          # subject-level bot cutoff on mean segment P(bot)
    model_version: str = ""
    features_version: int = 1
    meta: dict = field(default_factory=dict)  # bake-off results, chosen model name, etc.

    # ---- segment level -----------------------------------------------------
    def segment_proba(self, seg_df: pd.DataFrame) -> np.ndarray:
        """P(bot) for each segment row. Column order is pinned to self.features
        so a reordered/extra-column DataFrame cannot silently misalign."""
        X = seg_df[self.features].to_numpy(dtype=float)
        # Positive class is bot (label 1); find its column in classes_.
        classes = list(self.estimator.classes_)
        bot_col = classes.index(1) if 1 in classes else 1
        return self.estimator.predict_proba(X)[:, bot_col]

    # ---- subject level -----------------------------------------------------
    def subject_scores(self, seg_df: pd.DataFrame) -> pd.DataFrame:
        """Aggregate each subject's segment probabilities into one row:
        bot_probability (mean P(bot)), vote_share (fraction of segments the
        segment model calls bot), n_segments. This IS the prediction — the same
        aggregation evaluation measures and score.py ships."""
        proba = self.segment_proba(seg_df)
        work = pd.DataFrame({
            "subject_id": seg_df["subject_id"].to_numpy(),
            "_p": proba,
        })
        grouped = work.groupby("subject_id")["_p"]
        out = pd.DataFrame({
            "bot_probability": grouped.mean(),
            "vote_share": grouped.apply(lambda s: float(np.mean(s >= 0.5))),
            "n_segments": grouped.size().astype(int),
        }).reset_index()
        return out

    def subject_predict(self, seg_df: pd.DataFrame) -> pd.DataFrame:
        scores = self.subject_scores(seg_df)
        scores["predicted_label"] = np.where(
            scores["bot_probability"] >= self.threshold, "synthetic", "human"
        )
        return scores


def labels_to_is_bot(is_human_series: pd.Series) -> pd.Series:
    """Map the three-valued is_human (True/False/NULL) to the positive-class
    integer the models train on: bot = 1, human = 0. NULL must already be
    dropped upstream — this asserts it rather than silently coercing."""
    if is_human_series.isna().any():
        raise ValueError("is_human contains NULLs — filter unlabelled rows before training")
    return (~is_human_series.astype(bool)).astype(int)
