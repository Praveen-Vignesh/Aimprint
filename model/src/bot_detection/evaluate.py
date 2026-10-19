"""Evaluation harness for the hierarchical detector. Everything here is
held-out BY SUBJECT — never by row — because a subject's segments are
correlated samples of one motor process; the effective sample size is the
subject count, not the row count.

The headline unit is the SUBJECT (the thing we actually predict), so metrics
are pooled out-of-fold subject predictions, not per-segment numbers.

Reports (model/DESIGN.md + plan):
  * subject accuracy / precision / recall / F1 / balanced accuracy / ROC-AUC
  * the HUMAN FALSE-POSITIVE RATE (humans wrongly flagged) — the number the
    bare trainer omitted, and the one that matters most in practice
  * leave-one-bot-cohort-out recall (does it catch an unseen bot variant?)
  * permutation importance grouped by subject (did it learn aim or hardware?)
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import (
    balanced_accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold

from src.bot_detection.detector import HierarchicalBotDetector, labels_to_is_bot


def _subject_truth(seg_df: pd.DataFrame) -> pd.Series:
    """One bot/human label per subject (all a subject's rows agree). Returns a
    Series indexed by subject_id, value 1=bot, 0=human."""
    per = seg_df.groupby("subject_id")["is_human"].first()
    return (~per.astype(bool)).astype(int)


def _fit_segment_estimator(make_estimator, train_df, features):
    X = train_df[features].to_numpy(dtype=float)
    y = labels_to_is_bot(train_df["is_human"]).to_numpy()
    est = make_estimator()
    est.fit(X, y)
    return est


def subject_cv(seg_df: pd.DataFrame, make_estimator, features: list[str],
               n_splits: int = 5, threshold: float = 0.5) -> dict:
    """Grouped outer CV. For each fold, fit the segment model on training
    subjects, aggregate to a verdict on held-out subjects, pool the out-of-fold
    subject predictions, then compute subject-level metrics once on the pool."""
    groups = seg_df["subject_id"].to_numpy()
    uniq = np.unique(groups)
    if len(uniq) < 2:
        return {"skipped": f"only {len(uniq)} subject(s)"}
    n_splits = min(n_splits, len(uniq))

    truth = _subject_truth(seg_df)
    rows = []
    gkf = GroupKFold(n_splits=n_splits)
    # Split on segments but grouped by subject, so a subject is wholly in train
    # or wholly in test.
    seg_labels = labels_to_is_bot(seg_df["is_human"]).to_numpy()
    for tr, te in gkf.split(seg_df, seg_labels, groups):
        train_df = seg_df.iloc[tr]
        test_df = seg_df.iloc[te]
        if train_df["is_human"].nunique() < 2:
            continue  # a training fold of one class teaches nothing
        est = _fit_segment_estimator(make_estimator, train_df, features)
        det = HierarchicalBotDetector(est, features, threshold=threshold)
        scores = det.subject_predict(test_df)
        rows.append(scores.assign(true=scores["subject_id"].map(truth)))

    if not rows:
        return {"skipped": "no fold had both classes in training"}
    pooled = pd.concat(rows, ignore_index=True)
    y_true = pooled["true"].to_numpy()
    y_pred = (pooled["predicted_label"] == "synthetic").astype(int).to_numpy()
    y_prob = pooled["bot_probability"].to_numpy()

    n_human = int((y_true == 0).sum())
    fp = int(((y_true == 0) & (y_pred == 1)).sum())
    out = {
        "n_subjects_scored": int(len(pooled)),
        "accuracy": float(np.mean(y_true == y_pred)),
        "precision": float(precision_score(y_true, y_pred, zero_division=0)),
        "recall": float(recall_score(y_true, y_pred, zero_division=0)),
        "f1": float(f1_score(y_true, y_pred, zero_division=0)),
        "balanced_accuracy": float(balanced_accuracy_score(y_true, y_pred)),
        "human_false_positive_rate": (fp / n_human) if n_human else None,
        "confusion": {
            "tp": int(((y_true == 1) & (y_pred == 1)).sum()),
            "fp": fp,
            "tn": int(((y_true == 0) & (y_pred == 0)).sum()),
            "fn": int(((y_true == 1) & (y_pred == 0)).sum()),
        },
        "roc_auc": float(roc_auc_score(y_true, y_prob)) if len(np.unique(y_true)) == 2 else None,
    }
    return out


def leave_one_cohort_out(seg_df: pd.DataFrame, make_estimator, features: list[str],
                         threshold: float = 0.5) -> dict:
    """Hold out each bot cohort entirely; report recall on that unseen variant's
    subjects (fraction correctly flagged bot)."""
    bot_cohorts = sorted(
        seg_df.loc[~seg_df["is_human"].astype(bool), "subject_cohort"].dropna().unique()
    )
    if len(bot_cohorts) < 2:
        return {"skipped": f"only {len(bot_cohorts)} bot cohort(s); need ≥2"}
    truth = _subject_truth(seg_df)
    results = {}
    for cohort in bot_cohorts:
        held = seg_df["subject_cohort"] == cohort
        train_df = seg_df[~held]
        test_df = seg_df[held]
        if train_df["is_human"].nunique() < 2:
            results[cohort] = {"skipped": "training lost a class"}
            continue
        est = _fit_segment_estimator(make_estimator, train_df, features)
        det = HierarchicalBotDetector(est, features, threshold=threshold)
        pred = det.subject_predict(test_df)
        pred["true"] = pred["subject_id"].map(truth)
        caught = int((pred["predicted_label"] == "synthetic").sum())
        results[cohort] = {
            "held_subjects": int(len(pred)),
            "recall_on_unseen_bot": caught / len(pred) if len(pred) else None,
        }
    return results


def permutation_importance_grouped(seg_df: pd.DataFrame, make_estimator, features: list[str],
                                   n_splits: int = 5, n_repeats: int = 3,
                                   seed: int = 0) -> dict:
    """Approximate permutation importance measured at the SUBJECT level under
    grouped CV: for each feature, shuffle it within the held-out fold and record
    the drop in subject ROC-AUC, averaged over folds and repeats. Grouping by
    subject is what keeps it honest — a row-wise permutation test would leak."""
    groups = seg_df["subject_id"].to_numpy()
    uniq = np.unique(groups)
    if len(uniq) < 2:
        return {"skipped": f"only {len(uniq)} subject(s)"}
    n_splits = min(n_splits, len(uniq))
    rng = np.random.default_rng(seed)
    truth = _subject_truth(seg_df)
    seg_labels = labels_to_is_bot(seg_df["is_human"]).to_numpy()

    drops = {f: [] for f in features}
    gkf = GroupKFold(n_splits=n_splits)
    for tr, te in gkf.split(seg_df, seg_labels, groups):
        train_df, test_df = seg_df.iloc[tr], seg_df.iloc[te]
        if train_df["is_human"].nunique() < 2:
            continue
        est = _fit_segment_estimator(make_estimator, train_df, features)
        det = HierarchicalBotDetector(est, features)
        base = det.subject_predict(test_df)
        base_true = base["subject_id"].map(truth).to_numpy()
        if len(np.unique(base_true)) < 2:
            continue
        base_auc = roc_auc_score(base_true, base["bot_probability"].to_numpy())
        for f in features:
            fold_drops = []
            for _ in range(n_repeats):
                shuffled = test_df.copy()
                shuffled[f] = rng.permutation(shuffled[f].to_numpy())
                sc = det.subject_predict(shuffled)
                auc = roc_auc_score(sc["subject_id"].map(truth).to_numpy(),
                                    sc["bot_probability"].to_numpy())
                fold_drops.append(base_auc - auc)
            drops[f].append(float(np.mean(fold_drops)))

    return {f: (float(np.mean(v)) if v else None) for f, v in drops.items()}
