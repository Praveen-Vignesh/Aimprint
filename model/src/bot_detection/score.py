"""Scoring / prediction phase: run a trained detector over subjects and write
bot-probabilities to the service-key-only `predictions` table.

Run from model/:
    python -m src.score                      # score all kind='unknown' subjects
    python -m src.score --subject <uuid>     # demo: score one subject as-if-unknown
    python -m src.score --model <version>    # pick a specific model (default: latest)

Prediction and evaluation are the same operation — run the model on a subject it
did not train on. The only difference is that here we do NOT know the true label.

Predictions go to `predictions` (RLS-on-no-policy, service key only), NEVER to
`session_metrics` (which the player can read — a bot could read its own score and
evade). Writing a prediction NEVER touches `subjects.kind`; ground truth is only
ever set by a human.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.common import fetch_telemetry, registry  # noqa: E402
from src.common.features import build_segment_features  # noqa: E402

PREDICTIONS_TABLE = "predictions"


def score_subjects(detector, subject_ids=None, sampling_version=1):
    """Fetch the given subjects (or all `unknown` subjects), build features, and
    return the detector's per-subject verdicts. Scoring ignores labels, so a
    held-out labelled subject can be scored 'as if unknown' for a demo."""
    if subject_ids:
        # Score specific subjects regardless of their label (the demo path).
        raw = fetch_telemetry.fetch_core(
            ["human", "synthetic", "unknown"], sampling_version=sampling_version,
            subject_ids=subject_ids,
        )
    else:
        # Production path: only the unlabelled strangers.
        raw = fetch_telemetry.fetch_core(["unknown"], sampling_version=sampling_version)

    if raw.empty:
        return None
    feats = build_segment_features(raw)
    return detector.subject_predict(feats)


def main():
    ap = argparse.ArgumentParser(description="Score subjects and write predictions.")
    ap.add_argument("--model", default=None, help="model_version (default: latest in registry)")
    ap.add_argument("--subject", default=None, help="score one subject as-if-unknown (demo)")
    ap.add_argument("--dry-run", action="store_true", help="print predictions, do not write")
    args = ap.parse_args()

    detector = registry.load("bot_detection", args.model)
    subject_ids = [args.subject] if args.subject else None
    scores = score_subjects(detector, subject_ids)
    if scores is None or scores.empty:
        sys.exit("No subjects to score (no unknown subjects, or the subject has no segments).")

    scores["model_version"] = detector.model_version
    scores["features_version"] = detector.features_version
    print(scores[["subject_id", "bot_probability", "vote_share", "n_segments", "predicted_label"]].to_string(index=False))

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return

    client = fetch_telemetry._client()
    rows = [
        {
            "subject_id": r.subject_id,
            "model_version": r.model_version,
            "bot_probability": float(r.bot_probability),
            "predicted_label": r.predicted_label,
            "n_segments": int(r.n_segments),
            "features_version": int(r.features_version),
            "notes": {"vote_share": float(r.vote_share)},
        }
        for r in scores.itertuples()
    ]
    written = client.table(PREDICTIONS_TABLE).upsert(rows).execute().data
    print(f"\nWrote {len(written)} prediction row(s) to {PREDICTIONS_TABLE} "
          f"under model_version={detector.model_version}.")


if __name__ == "__main__":
    main()
