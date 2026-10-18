"""Trains the human-vs-bot detector on per-segment features and reports it
honestly. Run from model/:

    python -m src.train_bot_detector --in data/flick_features.parquet

Design decisions locked in model/DESIGN.md and the plan:
  * HistGradientBoostingClassifier — handles NaN natively (required: click-only
    features are NaN on non-click rows and must NOT be imputed) and supports
    class_weight='balanced'.
  * Split by subject_id with GroupKFold, NEVER by row — rows from one subject
    are correlated samples of one motor process; the effective sample size is
    the subject count, not the row count.
  * Leave-one-bot-cohort-out — hold out a whole bot variant and test on it.
    Accuracy that holds on an unseen variant means a detector; accuracy that
    needs every variant present means a recogniser.
  * Train twice (with and without the hardware block) to expose hardware
    leakage — a model scoring near-perfect on hardware rather than aim.
  * Every reported number carries the proof-of-concept caveat while subject
    counts are small. No bare accuracy ever gets printed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score, balanced_accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.features import FEATURE_COLUMNS, HARDWARE_COLUMNS  # noqa: E402

# Below this many subjects per class, held-out-subject estimates are too noisy
# to call anything but a proof of concept (DESIGN.md: ±8-9pp at ~20 subjects).
POC_SUBJECT_THRESHOLD = 10


def _new_model():
    return HistGradientBoostingClassifier(
        class_weight="balanced",
        random_state=0,
        early_stopping=False,  # datasets are tiny; the validation split would starve
    )


def _prepare(df: pd.DataFrame):
    """Drops unlabelled rows and returns (df, y_is_bot). is_human is three-valued
    (True/False/NULL); NULL is an unlabelled subject and must be dropped, never
    imputed (schema.sql / DESIGN.md)."""
    before = len(df)
    df = df[df["is_human"].notna()].copy()
    dropped = before - len(df)
    if dropped:
        print(f"Dropped {dropped} unlabelled rows (is_human NULL) — correct, not imputed.")
    # Positive class = BOT (this is a bot *detector*).
    y = (~df["is_human"].astype(bool)).astype(int)
    return df, y


def _grouped_cv(df: pd.DataFrame, y: pd.Series, cols, requested_splits: int) -> dict:
    groups = df["subject_id"].to_numpy()
    n_groups = len(np.unique(groups))
    if n_groups < 2:
        return {"skipped": f"only {n_groups} subject(s) — GroupKFold needs ≥2"}
    n_splits = min(requested_splits, n_groups)
    if n_splits < requested_splits:
        print(f"  [warn] only {n_groups} subjects; reducing GroupKFold to {n_splits} splits")

    X = df[cols].to_numpy(dtype=float)
    gkf = GroupKFold(n_splits=n_splits)
    accs, baccs, aucs = [], [], []
    for tr, te in gkf.split(X, y, groups):
        if len(np.unique(y.iloc[tr])) < 2:
            continue  # a fold whose training rows are one class teaches nothing
        model = _new_model()
        model.fit(X[tr], y.iloc[tr])
        pred = model.predict(X[te])
        accs.append(accuracy_score(y.iloc[te], pred))
        baccs.append(balanced_accuracy_score(y.iloc[te], pred))
        if len(np.unique(y.iloc[te])) == 2:
            aucs.append(roc_auc_score(y.iloc[te], model.predict_proba(X[te])[:, 1]))
    if not accs:
        return {"skipped": "no fold had both classes in training"}
    return {
        "n_splits": n_splits,
        "accuracy": float(np.mean(accs)),
        "balanced_accuracy": float(np.mean(baccs)),
        "roc_auc": float(np.mean(aucs)) if aucs else None,
    }


def _leave_one_cohort_out(df: pd.DataFrame, y: pd.Series, cols) -> dict:
    """Hold out each bot cohort entirely; report recall on that unseen variant
    (fraction of its rows correctly flagged as bot)."""
    results = {}
    bot_cohorts = sorted(
        c for c in df.loc[y == 1, "subject_cohort"].dropna().unique()
    )
    if len(bot_cohorts) < 2:
        return {"skipped": f"only {len(bot_cohorts)} bot cohort(s) — need ≥2 for a meaningful hold-out"}
    X = df[cols].to_numpy(dtype=float)
    for cohort in bot_cohorts:
        held = (df["subject_cohort"] == cohort).to_numpy()
        tr = ~held
        if len(np.unique(y[tr])) < 2:
            results[cohort] = {"skipped": "training set lost a class"}
            continue
        model = _new_model()
        model.fit(X[tr], y[tr])
        pred = model.predict(X[held])
        # Every held row is a bot (y==1), so recall == mean(pred == 1).
        results[cohort] = {
            "held_rows": int(held.sum()),
            "recall_on_unseen_bot": float(np.mean(pred == 1)),
        }
    return results


def main():
    ap = argparse.ArgumentParser(description="Train + honestly report a human-vs-bot detector.")
    ap.add_argument("--in", dest="in_path", required=True, help="per-segment feature parquet")
    ap.add_argument("--splits", type=int, default=5, help="requested GroupKFold splits")
    ap.add_argument("--model-out", default="models/bot_detector.joblib")
    args = ap.parse_args()

    df = pd.read_parquet(args.in_path)
    df, y = _prepare(df)
    if df.empty:
        sys.exit("No labelled rows after dropping is_human NULL — label some subjects first.")

    n_human = df.loc[y == 0, "subject_id"].nunique()
    n_bot = df.loc[y == 1, "subject_id"].nunique()
    n_bot_cohorts = df.loc[y == 1, "subject_cohort"].nunique()
    poc = min(n_human, n_bot) < POC_SUBJECT_THRESHOLD

    with_hw = FEATURE_COLUMNS + [c for c in HARDWARE_COLUMNS if c in df.columns]
    without_hw = FEATURE_COLUMNS

    report = {
        "rows": int(len(df)),
        "human_subjects": int(n_human),
        "bot_subjects": int(n_bot),
        "bot_cohorts": int(n_bot_cohorts),
        "proof_of_concept": bool(poc),
        "grouped_cv_with_hardware": _grouped_cv(df, y, with_hw, args.splits),
        "grouped_cv_without_hardware": _grouped_cv(df, y, without_hw, args.splits),
        "leave_one_bot_cohort_out": _leave_one_cohort_out(df, y, with_hw),
    }

    # Final artifact: trained on everything, with the hardware block.
    final = _new_model()
    final.fit(df[with_hw].to_numpy(dtype=float), y)
    model_out = Path(args.model_out)
    model_out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": final, "features": with_hw}, model_out)
    metrics_out = model_out.with_suffix(".metrics.json")
    metrics_out.write_text(json.dumps(report, indent=2))

    _print_report(report, model_out, metrics_out)


def _print_report(r: dict, model_out: Path, metrics_out: Path):
    print("\n" + "=" * 66)
    print("BOT DETECTOR — training report")
    print("=" * 66)
    if r["proof_of_concept"]:
        print("*** PROOF OF CONCEPT, NOT A PRODUCTION CLASSIFIER ***")
        print(f"    {r['human_subjects']} human + {r['bot_subjects']} bot subjects is far below")
        print("    what a defensible accuracy claim needs (~20 human + ≥5 bot variants).")
        print("    These numbers show the pipeline works and compare feature sets;")
        print("    they are NOT an accuracy claim about real bot detection.")
    print(f"\nrows={r['rows']}  human_subjects={r['human_subjects']}  "
          f"bot_subjects={r['bot_subjects']}  bot_cohorts={r['bot_cohorts']}")

    def line(label, cv):
        if "skipped" in cv:
            print(f"  {label}: skipped ({cv['skipped']})")
        else:
            auc = "n/a" if cv["roc_auc"] is None else f"{cv['roc_auc']:.3f}"
            print(f"  {label}: acc={cv['accuracy']:.3f} "
                  f"balanced_acc={cv['balanced_accuracy']:.3f} auc={auc} "
                  f"(splits={cv['n_splits']})")

    print("\nHeld-out-subject cross-validation:")
    line("with hardware   ", r["grouped_cv_with_hardware"])
    line("without hardware", r["grouped_cv_without_hardware"])
    print("  (a large with- vs without-hardware gap = the model learned the")
    print("   hardware, not the aim — see DESIGN.md hardware-leakage warning.)")

    print("\nLeave-one-bot-cohort-out (recall on an UNSEEN bot variant):")
    loco = r["leave_one_bot_cohort_out"]
    if "skipped" in loco:
        print(f"  skipped ({loco['skipped']}) — expected until ≥2 bot cohorts exist.")
    else:
        for cohort, res in loco.items():
            if "skipped" in res:
                print(f"  {cohort}: skipped ({res['skipped']})")
            else:
                print(f"  {cohort}: recall={res['recall_on_unseen_bot']:.3f} "
                      f"on {res['held_rows']} held-out rows")
        print("  (high recall on a variant the model never trained on = a real")
        print("   detector; low = a recogniser that only knows the bots it saw.)")

    print(f"\nSaved model  -> {model_out}")
    print(f"Saved metrics-> {metrics_out}")
    print("=" * 66)


if __name__ == "__main__":
    main()
