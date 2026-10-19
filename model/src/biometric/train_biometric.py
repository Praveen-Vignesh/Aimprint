"""Train (really: calibrate) the biometric verifier. There is no fitted model
in the classifier sense — "training" means measuring the EER on the enrol/verify
protocol and freezing the operating threshold. Run from model/:

    python -m src.biometric.train_biometric --in data/human_features.parquet
    python -m src.biometric.train_biometric            # fetch human subjects live

The per-subject templates are NOT in the artifact — they are written to the
biometric_templates table by enrol.py. The artifact holds only the feature order
+ the EER threshold + metadata.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.biometric import evaluate_biometric  # noqa: E402
from src.biometric.template import BIOMETRIC_FEATURES  # noqa: E402
from src.biometric.verify import BiometricVerifier  # noqa: E402
from src.common import registry  # noqa: E402


def _load_features(in_path: str | None) -> pd.DataFrame:
    if in_path:
        return pd.read_parquet(in_path)
    # Live: fetch human subjects and build features.
    from src.common import fetch_telemetry
    from src.common.features import build_segment_features
    raw = fetch_telemetry.fetch(None, "human", 1)
    if raw.empty:
        sys.exit("No human-labelled segments — label some subjects human first.")
    return build_segment_features(raw)


def main():
    ap = argparse.ArgumentParser(description="Calibrate the biometric verifier (EER).")
    ap.add_argument("--in", dest="in_path", default=None, help="feature parquet (else fetch live)")
    ap.add_argument("--enrol-sessions", type=int, default=3)
    args = ap.parse_args()

    feats = _load_features(args.in_path)
    report = evaluate_biometric.evaluate(feats, BIOMETRIC_FEATURES, args.enrol_sessions)
    if "skipped" in report:
        sys.exit(f"Cannot calibrate: {report['skipped']}. Need ≥2 subjects with "
                 f"enrol+verify sessions across different days.")

    report["headline"] = {"eer": report["eer"], "n_subjects": report["n_subjects"]}
    verifier = BiometricVerifier(
        features=list(BIOMETRIC_FEATURES),
        threshold=report["threshold"],
        features_version=1,
        meta={"chosen_model": "biometric_distance", "eer": report["eer"]},
    )
    version = registry.save(verifier, report, model_type="biometric")
    _print_report(report, version)


def _print_report(r: dict, version: str):
    print("\n" + "=" * 68)
    print(f"BIOMETRIC VERIFIER — {version}")
    print("=" * 68)
    print("*** RESEARCH DEMONSTRATION — NOT A STANDALONE AUTH FACTOR ***")
    print("    Aim behaviour drifts (fatigue/hardware/mood) and is replayable if a")
    print("    template leaks. Use at most as a SECONDARY risk signal, never the")
    print("    sole gate. At this subject count the EER band is very wide.")
    if r.get("proof_of_concept"):
        print(f"    Only {r['n_subjects']} subjects — proof of concept.")
    print(f"\nEER = {r['eer']:.3f}  (threshold={r['threshold']:.3f}, "
          f"FAR={r['far_at_eer']:.3f}, FRR={r['frr_at_eer']:.3f})")
    print(f"subjects={r['n_subjects']}  enrol_sessions={r['enrol_sessions']}  "
          f"genuine={r['n_genuine']} impostor={r['n_impostor']}")
    print(f"mean genuine distance={r['mean_genuine_distance']:.3f}  "
          f"mean impostor distance={r['mean_impostor_distance']:.3f}")
    print("  (genuine should sit well below impostor; if they overlap, the")
    print("   signature does not separate people at this data scale.)")
    print("=" * 68)


if __name__ == "__main__":
    main()
