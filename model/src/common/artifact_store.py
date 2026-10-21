"""Ships trained artifacts between the OFFLINE trainer and the RENDER service
through a private Supabase Storage bucket.

This is the delivery path that replaces git for model files: `models/*` is
gitignored and Render builds from git, so a trained `.joblib` never reaches the
image otherwise. Offline you run `upload_artifacts(...)` after training; on boot
the serving layer runs `download_latest(...)` before loading.

Reuses the Storage client pattern already proven in `src/archive_telemetry.py`
(`client.storage.from_(bucket).upload(...)` / `.download(...)`). The templates
themselves do NOT travel this way — they live in the `biometric_templates` table
and the service reads them live with the service key. Only the `.joblib`
artifacts + their metrics + `registry.json` go through here.

Run from model/:
    python -m src.common.artifact_store --upload --model-type bot_detection
    python -m src.common.artifact_store --upload --model-type biometric
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.common import fetch_telemetry, registry  # noqa: E402

# Overridable so a second environment (or a test) can target its own bucket.
BUCKET = os.environ.get("MODEL_ARTIFACT_BUCKET", "model-artifacts")

# octet-stream + upsert: re-uploading the same version overwrites in place
# rather than erroring on a duplicate key.
_UPLOAD_OPTS = {"content-type": "application/octet-stream", "upsert": "true"}


def _key(model_type: str, filename: str) -> str:
    return f"{model_type}/{filename}"


def _latest_version(index: list) -> str:
    return index[-1]["model_version"]


def upload_artifacts(model_type: str, version: str | None = None, client=None) -> list[str]:
    """Push a model type's `registry.json` plus one version's `.joblib` and
    `.metrics.json` to Storage. Defaults to the latest version in the local
    registry. Returns the uploaded storage keys."""
    client = client or fetch_telemetry._client()
    reg = registry._registry(model_type)
    if not reg.exists():
        raise FileNotFoundError(f"no local registry for {model_type} — train a model first")
    index = json.loads(reg.read_text())
    if not index:
        raise FileNotFoundError(f"local registry for {model_type} is empty")
    version = version or _latest_version(index)

    d = registry._dir(model_type)
    files = [reg, d / f"{version}.joblib", d / f"{version}.metrics.json"]
    missing = [str(f) for f in files if not f.exists()]
    if missing:
        raise FileNotFoundError(f"missing artifact file(s) for {version}: {missing}")

    keys = []
    for f in files:
        key = _key(model_type, f.name)
        with open(f, "rb") as fh:
            client.storage.from_(BUCKET).upload(key, fh.read(), _UPLOAD_OPTS)
        keys.append(key)
    return keys


def download_latest(model_type: str, dest: Path | None = None, client=None) -> str | None:
    """Pull a model type's latest artifacts from Storage into the local models/
    tree so `registry.load()` can read them. Returns the version pulled, or None
    when nothing is published yet — in which case the service reports the model
    unavailable, exactly as it does today."""
    client = client or fetch_telemetry._client()
    dest = dest or registry._dir(model_type)
    dest.mkdir(parents=True, exist_ok=True)

    try:
        reg_bytes = client.storage.from_(BUCKET).download(_key(model_type, "registry.json"))
    except Exception:
        return None  # nothing published for this type yet

    index = json.loads(reg_bytes)
    if not index:
        return None
    version = _latest_version(index)
    for name in (f"{version}.joblib", f"{version}.metrics.json"):
        data = client.storage.from_(BUCKET).download(_key(model_type, name))
        (dest / name).write_bytes(data)
    # registry.json is written last so a half-finished pull is not seen as complete.
    (dest / "registry.json").write_bytes(reg_bytes)
    return version


def main():
    ap = argparse.ArgumentParser(description="Upload/download model artifacts via Supabase Storage.")
    ap.add_argument("--model-type", required=True, choices=["bot_detection", "biometric"])
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--upload", action="store_true", help="push the latest local artifact")
    group.add_argument("--download", action="store_true", help="pull the latest published artifact")
    args = ap.parse_args()

    if args.upload:
        keys = upload_artifacts(args.model_type)
        print(f"Uploaded {len(keys)} file(s) to bucket '{BUCKET}':")
        for k in keys:
            print(f"  {k}")
    else:
        version = download_latest(args.model_type)
        if version is None:
            print(f"Nothing published for {args.model_type} in bucket '{BUCKET}'.")
        else:
            print(f"Downloaded {args.model_type} {version} from bucket '{BUCKET}'.")


if __name__ == "__main__":
    main()
