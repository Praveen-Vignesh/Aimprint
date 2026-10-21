"""FastAPI serving layer for both models — DEPLOY-READY, NOT DEPLOYED, and NOT
wired into the game. Run locally for a smoke check:

    uvicorn src.serving.app:app --reload     # from model/

Endpoints:
  GET  /health      — liveness + which model versions are loaded
  POST /bot-score   — {"segments": [ <decoded segment dicts> ]} -> per-subject verdicts
  POST /verify      — {"subject_id": "...", "segments": [...]}  -> same/different-person

⚠️ The /verify endpoint is a RESEARCH signal, never a standalone authentication
factor. Behaviour drifts and is replayable; use it at most as a secondary risk
signal behind a real auth method.
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.common import artifact_store, registry
from src.serving import inference


@asynccontextmanager
async def lifespan(app: FastAPI):
    """On boot, pull the latest trained artifacts from Supabase Storage into the
    local models/ tree BEFORE any lazy load. This is the serve-only half of the
    'train offline, Render serves' split: the image ships no model (models/* is
    gitignored), so the artifact arrives at runtime. Best-effort — a failure
    leaves the models unavailable and /health/ /status report it honestly rather
    than crashing the service."""
    for model_type in ("bot_detection", "biometric"):
        try:
            version = artifact_store.download_latest(model_type)
            print(f"[startup] {model_type}: "
                  f"{'pulled ' + version if version else 'nothing published yet'}")
        except Exception as exc:  # network / creds / bucket missing — non-fatal
            print(f"[startup] {model_type}: artifact sync skipped ({type(exc).__name__})")
    yield


app = FastAPI(title="Aimprint models", version="1", lifespan=lifespan)

# The browser calls /verify cross-origin (the game is on Vercel, this serves on
# Render), so the site origin must be allow-listed or the fetch is blocked. Only
# POST is needed and no cookies cross, so credentials stay off. Extra origins can
# be added via CORS_ALLOW_ORIGINS (comma-separated) without a code change.
_DEFAULT_ORIGINS = ["https://aimprint.vercel.app", "http://localhost:5173"]
_extra = [o.strip() for o in os.environ.get("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_DEFAULT_ORIGINS + _extra,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# Loaded lazily so the app starts (and /health answers) even before any model is
# trained — each endpoint reports clearly if its artifact is missing.
_state: dict = {"bot": None, "biometric": None}


def _bot():
    if _state["bot"] is None:
        _state["bot"] = inference.load_bot_detector()
    return _state["bot"]


def _biometric():
    if _state["biometric"] is None:
        _state["biometric"] = inference.load_biometric()
    return _state["biometric"]


class ScoreRequest(BaseModel):
    segments: list[dict]
    # The browser's wire segments carry no subject_id (it lives on the session
    # row, not the segment), so the caller names it here and the scorer stamps it
    # onto the rows before the subject-level aggregation groups by it.
    subject_id: str | None = None


class VerifyRequest(BaseModel):
    subject_id: str
    segments: list[dict]


@app.get("/health")
def health():
    status = {"status": "ok", "bot_model": None, "biometric_model": None}
    try:
        status["bot_model"] = _bot().model_version
    except Exception as exc:
        status["bot_model"] = f"unavailable: {type(exc).__name__}"
    try:
        status["biometric_model"] = _biometric().model_version
    except Exception as exc:
        status["biometric_model"] = f"unavailable: {type(exc).__name__}"
    return status


def _model_status(model_type: str) -> dict:
    """Latest version + headline metrics for one model type, read straight from
    the local registry.json (populated by the startup artifact sync). Feeds the
    recruiter-facing status dashboard — no model is loaded to answer this."""
    try:
        reg = registry._registry(model_type)
        if not reg.exists():
            return {"available": False}
        index = json.loads(reg.read_text())
        if not index:
            return {"available": False}
        latest = index[-1]
        return {
            "available": True,
            "model_version": latest.get("model_version"),
            "chosen_model": latest.get("chosen_model"),
            "n_features": latest.get("n_features"),
            "created_at": latest.get("created_at"),
            # headline is {balanced_accuracy, human_false_positive_rate, roc_auc}
            # for the bot detector and {eer, n_subjects} for the biometric verifier.
            "headline": latest.get("headline"),
        }
    except Exception as exc:
        return {"available": False, "error": type(exc).__name__}


@app.get("/status")
def status():
    """Public, read-only model status for the demo dashboard: which models are
    live and their headline numbers. Carries no per-player data."""
    return {
        "bot_detection": _model_status("bot_detection"),
        "biometric": _model_status("biometric"),
    }


@app.post("/bot-score")
def bot_score(req: ScoreRequest):
    if not req.segments:
        raise HTTPException(400, "no segments provided")
    try:
        return {"predictions": inference.score_bot(_bot(), req.segments, req.subject_id)}
    except FileNotFoundError:
        raise HTTPException(503, "bot detector not trained yet")


@app.post("/verify")
def verify(req: VerifyRequest):
    if not req.segments:
        raise HTTPException(400, "no segments provided")
    try:
        verifier = _biometric()
    except FileNotFoundError:
        raise HTTPException(503, "biometric verifier not trained yet")
    template = inference.get_template(req.subject_id)
    if template is None:
        raise HTTPException(404, f"subject {req.subject_id} is not enrolled")
    result = inference.verify(verifier, template, req.segments)
    result["note"] = "secondary signal only — not a standalone auth factor"
    return result
