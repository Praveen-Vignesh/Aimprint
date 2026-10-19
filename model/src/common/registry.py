"""Model versioning, namespaced by model type (bot_detection, biometric). Every
trained artifact gets a model_version = UTC date + model name + a short content
hash, so a row in predictions / biometric_templates always traces back to the
exact artifact that produced it. Writes models/<model_type>/<version>.joblib and
.metrics.json and keeps models/<model_type>/registry.json as an index.

Deliberately tiny — no MLflow, no DB. A finite campaign; a few files on disk is
the right weight.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib

MODELS_ROOT = Path(__file__).resolve().parents[2] / "models"


def _dir(model_type: str) -> Path:
    return MODELS_ROOT / model_type


def _registry(model_type: str) -> Path:
    return _dir(model_type) / "registry.json"


def make_version(features: list[str], chosen_model: str, metrics: dict) -> str:
    """UTC date + model name + 8-char hash of what defines behaviour (feature
    set + algorithm + headline metrics), so two models trained the same day are
    still distinguishable."""
    payload = json.dumps(
        {"features": features, "model": chosen_model, "metrics": metrics},
        sort_keys=True, default=str,
    )
    digest = hashlib.sha256(payload.encode()).hexdigest()[:8]
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    return f"{date}-{chosen_model}-{digest}"


def save(artifact, metrics: dict, model_type: str) -> str:
    """Persist any picklable artifact that carries `.features`, `.meta`, and a
    settable `.model_version`, plus its metrics. Returns the version."""
    d = _dir(model_type)
    d.mkdir(parents=True, exist_ok=True)
    version = make_version(artifact.features, artifact.meta.get("chosen_model", model_type), metrics)
    artifact.model_version = version

    joblib.dump(artifact, d / f"{version}.joblib")
    (d / f"{version}.metrics.json").write_text(json.dumps(metrics, indent=2, default=str))

    reg = _registry(model_type)
    index = json.loads(reg.read_text()) if reg.exists() else []
    index.append({
        "model_version": version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "chosen_model": artifact.meta.get("chosen_model"),
        "n_features": len(artifact.features),
        "headline": metrics.get("headline"),
    })
    reg.write_text(json.dumps(index, indent=2, default=str))
    return version


def load(model_type: str, version: str | None = None):
    """Load an artifact by version, or the most recent of its type if None."""
    reg = _registry(model_type)
    if version is None:
        if not reg.exists():
            raise FileNotFoundError(f"no models/{model_type}/registry.json — train one first")
        index = json.loads(reg.read_text())
        if not index:
            raise FileNotFoundError(f"models/{model_type}/registry.json is empty")
        version = index[-1]["model_version"]
    path = _dir(model_type) / f"{version}.joblib"
    if not path.exists():
        raise FileNotFoundError(f"no {model_type} model for version {version} at {path}")
    return joblib.load(path)
