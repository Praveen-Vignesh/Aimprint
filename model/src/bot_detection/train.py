"""Train the hierarchical bot detector: a bake-off across model families, each
tuned with NESTED subject-grouped cross-validation, keep the winner, persist it
through the registry with a full honest report.

Run from model/:
    python -m src.train --in data/flick_features.parquet

Why nested CV (plan): tuning hyperparameters on the same split you report leaks
and inflates the number. The OUTER GroupKFold (by subject) gives the honest
estimate; the hyperparameter search runs in the INNER loop of each outer fold,
on training subjects only. At ~25 subjects this mostly buys stability, not
accuracy — the headline stays proof-of-concept and the report says so.

Everything is grouped by subject_id, never by row.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GridSearchCV, GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.bot_detection import evaluate  # noqa: E402
from src.common import registry  # noqa: E402
from src.bot_detection.detector import HierarchicalBotDetector, labels_to_is_bot  # noqa: E402
from src.common.features import FEATURE_COLUMNS, HARDWARE_COLUMNS  # noqa: E402

POC_SUBJECT_THRESHOLD = 10


# ---------------------------------------------------------------------------
# Candidate model families. Logistic/RF cannot take NaN, so they impute with an
# explicit "missing" INDICATOR (add_indicator=True) rather than a fabricated
# value — encoding "no click happened" as a signal, not a fake reaction time.
# HGB takes NaN natively, so it needs no imputer.
# ---------------------------------------------------------------------------
def _logistic():
    return Pipeline([
        ("impute", SimpleImputer(strategy="constant", fill_value=0.0, add_indicator=True)),
        ("scale", StandardScaler()),
        ("clf", LogisticRegression(class_weight="balanced", max_iter=1000)),
    ])


def _random_forest():
    return Pipeline([
        ("impute", SimpleImputer(strategy="constant", fill_value=0.0, add_indicator=True)),
        ("clf", RandomForestClassifier(class_weight="balanced", random_state=0)),
    ])


def _hgb():
    return HistGradientBoostingClassifier(class_weight="balanced", random_state=0)


CANDIDATES = {
    "logistic":       (_logistic,      {"clf__C": [0.1, 1.0, 10.0]}),
    "random_forest":  (_random_forest, {"clf__n_estimators": [200, 400], "clf__max_depth": [None, 8]}),
    "hgb":            (_hgb,           {"learning_rate": [0.05, 0.1], "max_depth": [None, 6]}),
}


def _prepare(df: pd.DataFrame) -> pd.DataFrame:
    before = len(df)
    df = df[df["is_human"].notna()].copy()
    if before - len(df):
        print(f"Dropped {before - len(df)} unlabelled rows (is_human NULL) — not imputed.")
    return df


def _inner_splits(n_train_groups: int) -> int | None:
    """Inner GroupKFold split count for a given outer-train group count, or None
    when tuning isn't possible (fall back to default params)."""
    if n_train_groups < 2:
        return None
    return max(2, min(3, n_train_groups))


def _tuned_fit(make_est, grid, train_df, features):
    """Fit on outer-train subjects, tuning hyperparameters with an INNER
    GroupKFold over those same subjects. Degrades gracefully to a default-params
    fit when there are too few groups to split, or when the inner search cannot
    score (every inner fold going single-class makes every combo NaN, which would
    make GridSearchCV's refit raise). Scoring is 'accuracy' — always defined,
    unlike roc_auc which is undefined on a single-class fold."""
    X = train_df[features].to_numpy(dtype=float)
    y = labels_to_is_bot(train_df["is_human"]).to_numpy()
    groups = train_df["subject_id"].to_numpy()
    inner = _inner_splits(len(np.unique(groups)))
    if inner is not None:
        try:
            search = GridSearchCV(
                make_est(), grid, cv=GroupKFold(n_splits=inner),
                scoring="accuracy", refit=True,
            )
            search.fit(X, y, groups=groups)
            return search.best_estimator_, search.best_params_
        except Exception as exc:  # tiny-data degeneracy — fall back, don't crash
            print(f"  [warn] inner tuning fell back to defaults ({type(exc).__name__})")
    est = make_est()
    est.fit(X, y)
    return est, {}


def _nested_subject_score(make_est, grid, seg_df, features, outer_splits):
    """Outer GroupKFold → tuned fit per fold → aggregate to subject verdicts →
    pool out-of-fold subject predictions → subject-level balanced accuracy + AUC.
    This is the honest estimate used to pick the winning family."""
    groups = seg_df["subject_id"].to_numpy()
    uniq = np.unique(groups)
    if len(uniq) < 2:
        return None
    outer = min(outer_splits, len(uniq))
    seg_y = labels_to_is_bot(seg_df["is_human"]).to_numpy()
    truth = seg_df.groupby("subject_id")["is_human"].first()
    truth = (~truth.astype(bool)).astype(int)

    rows = []
    gkf = GroupKFold(n_splits=outer)
    for tr, te in gkf.split(seg_df, seg_y, groups):
        train_df, test_df = seg_df.iloc[tr], seg_df.iloc[te]
        if train_df["is_human"].nunique() < 2:
            continue
        est, _ = _tuned_fit(make_est, grid, train_df, features)
        det = HierarchicalBotDetector(est, features)
        sc = det.subject_predict(test_df)
        sc["true"] = sc["subject_id"].map(truth)
        rows.append(sc)
    if not rows:
        return None
    pooled = pd.concat(rows, ignore_index=True)
    yt = pooled["true"].to_numpy()
    yp = (pooled["predicted_label"] == "synthetic").astype(int).to_numpy()
    from sklearn.metrics import balanced_accuracy_score, roc_auc_score
    return {
        "balanced_accuracy": float(balanced_accuracy_score(yt, yp)),
        "roc_auc": float(roc_auc_score(yt, pooled["bot_probability"])) if len(np.unique(yt)) == 2 else None,
    }


def main():
    ap = argparse.ArgumentParser(description="Bake-off + nested-CV tuning for the bot detector.")
    ap.add_argument("--in", dest="in_path", required=True, help="per-segment feature parquet")
    ap.add_argument("--outer-splits", type=int, default=5)
    args = ap.parse_args()

    df = _prepare(pd.read_parquet(args.in_path))
    if df.empty:
        sys.exit("No labelled rows after dropping is_human NULL — label subjects first.")

    # Behaviour only. The served detector is fit on behavioural features
    # (velocity/trajectory/timing) and NEVER on the session hardware block
    # (dpi/sens/cm_per_360/fov_deg/refresh_hz/poll_hz). Two reasons, both
    # load-bearing: (1) a detector that keys on the rig is detecting hardware, not
    # bot behaviour — trivially spoofable and not a meaningful signal; (2) those
    # columns are session-scoped and poll_hz is service-derived (NULL during
    # collection), so they are NOT in the browser's wire segment at serve time —
    # a model that depends on them mislabels real humans the instant they are
    # absent. `features_with_hw` is retained ONLY to compute the leakage diagnostic
    # below (a throwaway CV, never the shipped model).
    features_no_hw = FEATURE_COLUMNS
    features_with_hw = FEATURE_COLUMNS + [c for c in HARDWARE_COLUMNS if c in df.columns]
    n_human = df.loc[df["is_human"].astype(bool), "subject_id"].nunique()
    n_bot = df.loc[~df["is_human"].astype(bool), "subject_id"].nunique()
    poc = min(n_human, n_bot) < POC_SUBJECT_THRESHOLD

    # Bake-off: nested subject score per family (behavioural features only). A
    # single family blowing up on a degenerate fold (e.g. HGB's binning raising
    # "window shape cannot be larger than input array shape" when a subject
    # contributes very few segments, so an inner fold is tiny) must not abort the
    # whole bake-off — treat it as unscored and let the surviving families
    # compete.
    bakeoff = {}
    for name, (make_est, grid) in CANDIDATES.items():
        try:
            bakeoff[name] = _nested_subject_score(make_est, grid, df, features_no_hw, args.outer_splits)
        except Exception as exc:
            bakeoff[name] = None
            print(f"  {name}: skipped ({type(exc).__name__}: {exc})")
            continue
        print(f"  {name}: {bakeoff[name]}")

    scored = {k: v for k, v in bakeoff.items() if v and v["balanced_accuracy"] is not None}
    if not scored:
        sys.exit("No candidate produced a nested score — too few subjects/classes. Collect more data.")
    chosen = max(scored, key=lambda k: scored[k]["balanced_accuracy"])
    make_est, grid = CANDIDATES[chosen]
    print(f"Chosen family: {chosen}")

    # Final honest evaluation of the chosen family (reuses evaluate.py).
    def chosen_factory():
        return make_est()

    report = {
        "rows": int(len(df)),
        "human_subjects": int(n_human),
        "bot_subjects": int(n_bot),
        "proof_of_concept": bool(poc),
        "bakeoff": bakeoff,
        "chosen_model": chosen,
        # The served model is behavioural-only; subject_cv_without_hardware is its
        # honest held-out estimate and feeds the headline. subject_cv_with_hardware
        # is a LEAKAGE DIAGNOSTIC only (a throwaway CV fit with the hardware block
        # added) — a large with- vs without-hardware gap would mean the hardware
        # was carrying the signal. It is never the shipped model.
        "subject_cv_without_hardware": evaluate.subject_cv(df, chosen_factory, features_no_hw, args.outer_splits),
        "subject_cv_with_hardware": evaluate.subject_cv(df, chosen_factory, features_with_hw, args.outer_splits),
        "leave_one_bot_cohort_out": evaluate.leave_one_cohort_out(df, chosen_factory, features_no_hw),
        "permutation_importance": evaluate.permutation_importance_grouped(df, chosen_factory, features_no_hw, args.outer_splits),
    }
    cv = report["subject_cv_without_hardware"]
    report["headline"] = None if "skipped" in cv else {
        "balanced_accuracy": cv["balanced_accuracy"],
        "human_false_positive_rate": cv["human_false_positive_rate"],
        "roc_auc": cv["roc_auc"],
    }

    # Fit the final (served) model on ALL data with tuned params, BEHAVIOURAL
    # FEATURES ONLY, wrap, persist. features_no_hw is the serving contract: every
    # column here is present in the browser's wire segment.
    final_est, best_params = _tuned_fit(make_est, grid, df, features_no_hw)
    detector = HierarchicalBotDetector(
        final_est, features_no_hw,
        meta={"chosen_model": chosen, "best_params": best_params, "bakeoff": bakeoff},
    )
    version = registry.save(detector, report, model_type="bot_detection")
    _print_report(report, version)


def _print_report(r: dict, version: str):
    print("\n" + "=" * 68)
    print(f"BOT DETECTOR — {version}")
    print("=" * 68)
    if r["proof_of_concept"]:
        print("*** PROOF OF CONCEPT, NOT A PRODUCTION CLASSIFIER ***")
        print(f"    {r['human_subjects']} human + {r['bot_subjects']} bot subjects is far below")
        print("    a defensible claim (~20 human + ≥5 bot variants). The pipeline is")
        print("    complete and honest; the NUMBER is not an accuracy claim.")
    print(f"\nchosen family: {r['chosen_model']}   rows={r['rows']}")

    def line(label, cv):
        if "skipped" in cv:
            print(f"  {label}: skipped ({cv['skipped']})")
            return
        auc = "n/a" if cv["roc_auc"] is None else f"{cv['roc_auc']:.3f}"
        fp = "n/a" if cv["human_false_positive_rate"] is None else f"{cv['human_false_positive_rate']:.3f}"
        print(f"  {label}: bal_acc={cv['balanced_accuracy']:.3f} f1={cv['f1']:.3f} "
              f"auc={auc} human_FP_rate={fp}")

    print("\nHeld-out-subject CV:")
    line("with hardware   ", r["subject_cv_with_hardware"])
    line("without hardware", r["subject_cv_without_hardware"])
    print("  (large with- vs without-hardware gap = learned hardware, not aim.)")

    loco = r["leave_one_bot_cohort_out"]
    print("\nLeave-one-bot-cohort-out (recall on an UNSEEN variant):")
    if "skipped" in loco:
        print(f"  skipped ({loco['skipped']})")
    else:
        for cohort, res in loco.items():
            if "skipped" in res:
                print(f"  {cohort}: skipped ({res['skipped']})")
            else:
                print(f"  {cohort}: recall={res['recall_on_unseen_bot']:.3f} "
                      f"on {res['held_subjects']} subjects")

    imp = r["permutation_importance"]
    if "skipped" not in imp:
        ranked = sorted(((f, v) for f, v in imp.items() if v is not None),
                        key=lambda kv: kv[1], reverse=True)[:8]
        print("\nTop features (permutation importance, subject-grouped):")
        for f, v in ranked:
            print(f"  {f}: {v:+.4f}")
    print("=" * 68)


if __name__ == "__main__":
    main()
