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

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from src.serving import inference

app = FastAPI(title="Aimprint models", version="1")

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


@app.post("/bot-score")
def bot_score(req: ScoreRequest):
    if not req.segments:
        raise HTTPException(400, "no segments provided")
    try:
        return {"predictions": inference.score_bot(_bot(), req.segments)}
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
