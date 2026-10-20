"""Biometric evaluation: the Equal Error Rate (EER) from genuine vs impostor
verification distances, using an enrol-early / verify-late split BY CALENDAR DAY.

Protocol (DESIGN.md): a subject's earliest sessions enrol a template; their
later sessions ON A STRICTLY LATER CALENDAR DAY are the genuine verify trials;
every OTHER subject's verify sessions scored against that template are impostor
trials. Verifying on a later day is the whole point — same-day sessions share
warm-up/seating state a model can mistake for identity, so a cross-day split is
what proves it learned the person, not the sitting. A subject with only one day
of data cannot be a cross-day verify trial and is skipped (honestly) rather than
verified against itself within the day.

EER is reported via LEAVE-ONE-SUBJECT-OUT: for each held-out subject the operating
threshold is calibrated on the OTHER subjects' trials and then applied to the
held-out subject's trials. This stops the threshold from being chosen on the same
distances it is scored on (which flatters the number). The threshold PERSISTED in
the artifact is calibrated on all subjects — legitimate, because in deployment it
is applied to new subjects who were never in calibration.

At ~25 subjects the EER confidence interval is very wide — this is a demonstration
metric, reported with that caveat, not a security guarantee.
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


def _session_dates(sub_df: pd.DataFrame) -> dict:
    """{session_id: calendar date} for one subject (None where unparseable)."""
    t = pd.to_datetime(sub_df["session_started_at"], errors="coerce")
    by = sub_df.assign(_t=t).groupby("session_id")["_t"].min()
    return {sid: (ts.date() if pd.notna(ts) else None) for sid, ts in by.items()}


def enrol_frames(seg_df: pd.DataFrame, enrol_sessions: int = 3) -> dict:
    """{subject_id: enrol_seg_df} from each subject's EARLIEST sessions, for
    template building (enrol.py). This does NOT require a verify day — any
    subject with ≥1 session is included — so enrolment is possible from a single
    sitting even though cross-day EVALUATION of that subject is not."""
    out = {}
    for subject_id, sub in seg_df.groupby("subject_id"):
        sessions = _session_order(sub)
        enrol_ids = sessions[:enrol_sessions]
        out[subject_id] = sub[sub["session_id"].isin(enrol_ids)]
    return out


def enrol_verify_split(seg_df: pd.DataFrame, enrol_sessions: int = 3):
    """Per subject: (enrol_seg_df, [(verify_session_id, verify_seg_df), ...]),
    with verify trials restricted to sessions on a STRICTLY LATER calendar day
    than the last enrol session. Subjects without at least one enrol day and one
    strictly-later verify day are skipped."""
    out = {}
    for subject_id, sub in seg_df.groupby("subject_id"):
        sessions = _session_order(sub)
        if len(sessions) < 2:
            continue
        dates = _session_dates(sub)

        enrol_ids = sessions[:enrol_sessions]
        enrol_dates = [dates[s] for s in enrol_ids if dates[s] is not None]
        last_enrol_date = max(enrol_dates) if enrol_dates else None
        verify_ids = [
            s for s in sessions[enrol_sessions:]
            if dates[s] is not None and last_enrol_date is not None and dates[s] > last_enrol_date
        ]

        if not verify_ids:
            # Too few sessions for a clean earliest-N split, OR all the later
            # sessions fell on an enrol day. Fall back to "enrol on every earlier
            # day, verify on the last day" — still strictly cross-day.
            all_dates = sorted({d for d in dates.values() if d is not None})
            if len(all_dates) < 2:
                continue  # single calendar day — no cross-day verify possible
            cutoff = all_dates[-1]
            enrol_ids = [s for s in sessions if dates[s] is not None and dates[s] < cutoff]
            verify_ids = [s for s in sessions if dates[s] == cutoff]
            if not enrol_ids or not verify_ids:
                continue

        enrol_df = sub[sub["session_id"].isin(enrol_ids)]
        verify = [(sid, sub[sub["session_id"] == sid]) for sid in verify_ids]
        out[subject_id] = (enrol_df, verify)
    return out


def _eer_point(genuine: np.ndarray, impostor: np.ndarray) -> dict | None:
    """The equal-error operating point over the pooled distances: the threshold
    minimizing |FAR - FRR|. Lower distance = more genuine, so a trial is ACCEPTED
    when distance < threshold."""
    g = np.asarray(genuine, dtype=float)
    im = np.asarray(impostor, dtype=float)
    g = g[np.isfinite(g)]
    im = im[np.isfinite(im)]
    if len(g) == 0 or len(im) == 0:
        return None
    thresholds = np.unique(np.concatenate([g, im]))
    best = None
    for t in thresholds:
        far = float(np.mean(im < t))   # impostors accepted
        frr = float(np.mean(g >= t))   # genuines rejected
        gap = abs(far - frr)
        if best is None or gap < best["gap"]:
            best = {"gap": gap, "threshold": float(t), "far": far, "frr": frr}
    return best


def _trials_by_owner(split, features) -> tuple[dict, dict, dict]:
    """Templates + per-template-owner genuine/impostor distance lists."""
    templates = {sid: build_template(enrol, features) for sid, (enrol, _) in split.items()}
    genuine_by, impostor_by = {}, {}
    for sid, (_, verify_sessions) in split.items():
        genuine_by[sid] = [template_distance(templates[sid], vdf) for _, vdf in verify_sessions]
        imp = []
        for other, (_, other_verify) in split.items():
            if other == sid:
                continue
            for _, vdf in other_verify:
                imp.append(template_distance(templates[sid], vdf))
        impostor_by[sid] = imp
    return templates, genuine_by, impostor_by


def _loso_eer(genuine_by: dict, impostor_by: dict) -> dict | None:
    """Leave-one-subject-out EER: for each held-out owner, calibrate the EER
    threshold on the OTHER owners' trials, apply it to the held-out owner's
    trials, then pool the held-out decisions. Needs ≥3 owners (hold one out,
    calibrate on ≥2); returns None otherwise."""
    owners = list(genuine_by)
    if len(owners) < 3:
        return None
    far_num = far_den = frr_num = frr_den = 0
    for held in owners:
        og = np.array([x for s in owners if s != held for x in genuine_by[s]], float)
        oi = np.array([x for s in owners if s != held for x in impostor_by[s]], float)
        point = _eer_point(og, oi)
        if point is None:
            continue
        t = point["threshold"]
        hg = np.array(genuine_by[held], float); hg = hg[np.isfinite(hg)]
        hi = np.array(impostor_by[held], float); hi = hi[np.isfinite(hi)]
        frr_num += int(np.sum(hg >= t)); frr_den += len(hg)
        far_num += int(np.sum(hi < t)); far_den += len(hi)
    if not far_den or not frr_den:
        return None
    far = far_num / far_den
    frr = frr_num / frr_den
    return {"eer": (far + frr) / 2, "far_at_eer": far, "frr_at_eer": frr}


def evaluate(seg_df: pd.DataFrame, features: list[str] = BIOMETRIC_FEATURES,
             enrol_sessions: int = 3) -> dict:
    """Build a template per subject, score genuine + impostor cross-day verify
    trials, return the EER report. The reported EER is leave-one-subject-out when
    there are ≥3 subjects; below that it falls back to the in-sample point with
    eer_method='in_sample' so the optimism is labelled, not hidden."""
    split = enrol_verify_split(seg_df, enrol_sessions)
    if len(split) < 2:
        return {"skipped": f"only {len(split)} subject(s) with cross-day enrol+verify sessions"}

    _, genuine_by, impostor_by = _trials_by_owner(split, features)
    all_g = np.array([x for v in genuine_by.values() for x in v], float)
    all_im = np.array([x for v in impostor_by.values() for x in v], float)
    all_g = all_g[np.isfinite(all_g)]
    all_im = all_im[np.isfinite(all_im)]

    full = _eer_point(all_g, all_im)
    if full is None:
        return {"skipped": f"genuine={len(all_g)} impostor={len(all_im)} — need both"}

    loso = _loso_eer(genuine_by, impostor_by)
    in_sample_eer = (full["far"] + full["frr"]) / 2
    reported = loso if loso else {
        "eer": in_sample_eer, "far_at_eer": full["far"], "frr_at_eer": full["frr"],
    }

    return {
        "eer": reported["eer"],
        "far_at_eer": reported["far_at_eer"],
        "frr_at_eer": reported["frr_at_eer"],
        # Persisted threshold: calibrated on ALL subjects. No leak — in deployment
        # it is applied to NEW subjects, never one it was calibrated on.
        "threshold": full["threshold"],
        "eer_method": "loso" if loso else "in_sample",
        "in_sample_eer": in_sample_eer,
        "n_genuine": int(len(all_g)),
        "n_impostor": int(len(all_im)),
        "mean_genuine_distance": float(np.mean(all_g)),
        "mean_impostor_distance": float(np.mean(all_im)),
        "n_subjects": len(split),
        "enrol_sessions": enrol_sessions,
        "proof_of_concept": len(split) < 10,
    }
