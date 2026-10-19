"""Biometric evaluation: the Equal Error Rate (EER) from genuine vs impostor
verification distances, using an enrol-early / verify-late split BY DAY.

Protocol (DESIGN.md): a subject's earliest sessions enrol a template; their
later sessions (on different days) are the genuine verify trials; every OTHER
subject's verify sessions scored against that template are impostor trials.
Splitting by day is the whole point — same-day sessions share warm-up/seating
state a model can mistake for identity, so verifying on a later day is what
proves it learned the person.

EER is the standard biometric operating point (where false-accept == false-
reject). At ~25 subjects its confidence interval is very wide — this is a
demonstration metric, reported with that caveat, not a security guarantee.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.biometric.template import BIOMETRIC_FEATURES, build_template
from src.biometric.verify import template_distance


def _session_order(sub_df: pd.DataFrame) -> list:
    """Session ids for one subject, ordered by first play time (day order)."""
    if "session_started_at" not in sub_df.columns:
        raise ValueError("session_started_at missing — add it to the feature frame "
                         "(IDENTITY_COLUMNS) so enrol/verify can split by day")
    order = (
        sub_df.assign(_t=pd.to_datetime(sub_df["session_started_at"], errors="coerce"))
        .groupby("session_id")["_t"].min()
        .sort_values()
    )
    return list(order.index)


def enrol_verify_split(seg_df: pd.DataFrame, enrol_sessions: int = 3):
    """Per subject: (enrol_seg_df, [(verify_session_id, verify_seg_df), ...]).
    Subjects without at least one enrol and one verify session are skipped."""
    out = {}
    for subject_id, sub in seg_df.groupby("subject_id"):
        sessions = _session_order(sub)
        if len(sessions) < 2:
            continue
        enrol_ids = sessions[:enrol_sessions]
        verify_ids = sessions[enrol_sessions:]
        if not verify_ids:  # too few sessions: last one becomes verify
            enrol_ids, verify_ids = sessions[:-1], sessions[-1:]
        enrol_df = sub[sub["session_id"].isin(enrol_ids)]
        verify = [(sid, sub[sub["session_id"] == sid]) for sid in verify_ids]
        out[subject_id] = (enrol_df, verify)
    return out


def _eer(genuine: np.ndarray, impostor: np.ndarray) -> dict:
    g = np.asarray(genuine, dtype=float)
    im = np.asarray(impostor, dtype=float)
    g = g[np.isfinite(g)]
    im = im[np.isfinite(im)]
    if len(g) == 0 or len(im) == 0:
        return {"skipped": f"genuine={len(g)} impostor={len(im)} — need both"}
    thresholds = np.unique(np.concatenate([g, im]))
    best = None
    for t in thresholds:
        far = float(np.mean(im < t))   # impostors accepted
        frr = float(np.mean(g >= t))   # genuines rejected
        gap = abs(far - frr)
        if best is None or gap < best["gap"]:
            best = {"gap": gap, "threshold": float(t), "far": far, "frr": frr}
    return {
        "eer": (best["far"] + best["frr"]) / 2,
        "threshold": best["threshold"],
        "far_at_eer": best["far"],
        "frr_at_eer": best["frr"],
        "n_genuine": int(len(g)),
        "n_impostor": int(len(im)),
        "mean_genuine_distance": float(np.mean(g)),
        "mean_impostor_distance": float(np.mean(im)),
    }


def evaluate(seg_df: pd.DataFrame, features: list[str] = BIOMETRIC_FEATURES,
             enrol_sessions: int = 3) -> dict:
    """Build a template per subject, score genuine + impostor verify trials,
    return the EER report."""
    split = enrol_verify_split(seg_df, enrol_sessions)
    if len(split) < 2:
        return {"skipped": f"only {len(split)} subject(s) with enrol+verify sessions"}

    templates = {sid: build_template(enrol, features) for sid, (enrol, _) in split.items()}

    genuine, impostor = [], []
    for sid, (_, verify_sessions) in split.items():
        for _, vdf in verify_sessions:
            genuine.append(template_distance(templates[sid], vdf))
        for other, (_, other_verify) in split.items():
            if other == sid:
                continue
            for _, vdf in other_verify:
                impostor.append(template_distance(templates[sid], vdf))

    report = _eer(np.array(genuine), np.array(impostor))
    report["n_subjects"] = len(split)
    report["enrol_sessions"] = enrol_sessions
    report["proof_of_concept"] = len(split) < 10
    return report
