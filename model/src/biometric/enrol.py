"""Write per-subject biometric templates to the service-key-only
biometric_templates table. Run from model/:

    python -m src.biometric.enrol                 # enrol all human subjects
    python -m src.biometric.enrol --dry-run

Templates are built from each subject's ENROL (earliest) sessions and are NEVER
client-readable (the table has RLS on with no policy) — a readable template
would make the verification gate trivially replayable.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.biometric import evaluate_biometric  # noqa: E402
from src.biometric.template import BIOMETRIC_FEATURES, build_template  # noqa: E402
from src.common import fetch_telemetry  # noqa: E402
from src.common.features import build_segment_features  # noqa: E402

TEMPLATES_TABLE = "biometric_templates"


def main():
    ap = argparse.ArgumentParser(description="Enrol biometric templates for human subjects.")
    ap.add_argument("--enrol-sessions", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    raw = fetch_telemetry.fetch(None, "human", 1)
    if raw.empty:
        sys.exit("No human-labelled segments to enrol.")
    feats = build_segment_features(raw)
    split = evaluate_biometric.enrol_verify_split(feats, args.enrol_sessions)
    if not split:
        sys.exit("No subjects with enough sessions to enrol.")

    version = datetime.now(timezone.utc).strftime("%Y%m%d")
    rows = []
    for subject_id, (enrol_df, _) in split.items():
        tmpl = build_template(enrol_df, BIOMETRIC_FEATURES)
        rows.append({
            "subject_id": subject_id,
            "template_version": version,
            "signature": tmpl,
            "n_enrol_sessions": tmpl["n_enrol_sessions"],
            "features_version": tmpl["features_version"],
        })
        print(f"  {subject_id}: template from {tmpl['n_enrol_sessions']} enrol session(s), "
              f"{tmpl['n_enrol_segments']} segments")

    if args.dry_run:
        print(f"\n--dry-run: {len(rows)} template(s) built, nothing written.")
        return

    client = fetch_telemetry._client()
    written = client.table(TEMPLATES_TABLE).upsert(rows).execute().data
    print(f"\nEnrolled {len(written)} template(s) to {TEMPLATES_TABLE} (version {version}).")


if __name__ == "__main__":
    main()
