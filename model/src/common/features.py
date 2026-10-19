"""Turns decoded segments (fetch_telemetry.py output, each row a
v_training_segments row with trajectory/input_events already decoded to
absolute values by codec.py) into model-ready feature tables.

TWO LEVELS, because the signals live at two granularities (see
model/DESIGN.md and the plan):

  build_segment_features(df)  -> one row per segment (thousands of rows)
  build_subject_features(df)  -> one row per subject (~tens of rows)

Hard rules (DESIGN.md, enforced here, never worked around):
  * Click-only fields (time_to_click_ms, dwell_ms, click offsets) stay NaN on
    non-click (timeout/track) rows. Never imputed — a fabricated reaction time
    teaches the classifier a lie. schema.sql enforces the same at write time.
  * Every diff-based statistic is guarded against a single-frame segment:
    len < 2 yields NaN, never a divide-by-zero or an exception.

Each feature is grouped by the human motor signature it targets; see the plan
for why each was chosen and which are hard vs easy for a bot to fake.
"""

from __future__ import annotations

import argparse
import ast
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Column groups — exported so train_bot_detector.py never guesses which
# columns are model inputs vs identity/label vs hardware.
# ---------------------------------------------------------------------------
CLICK_ONLY_COLUMNS = ["time_to_click_ms", "dwell_ms", "click_offset_x", "click_offset_y"]

# submovement_count carries the ballistic+correction signal the USPTO
# submovement patent describes. A separate `overshoot_distance` is deferred:
# computing it honestly needs the engaged target's per-frame ANGULAR position,
# which static-target routines omit (tx/ty/tz dropped) and which requires
# reconstructing the fixed camera geometry — not yet verified. A constant-zero
# stub would be a fabricated feature, so it is left out until that geometry is
# confirmed, rather than shipped dead. See the plan.
BALLISTIC_FEATURES = [
    "peak_angular_speed",
    "time_to_peak_fraction",
    "velocity_skew",
    "submovement_count",
]
SMOOTHNESS_FEATURES = ["sparc", "jerk_std"]
PATH_FEATURES = ["straightness", "on_target_ratio", "on_entry_abruptness"]
TREMOR_FEATURES = ["tremor_band_power", "reversal_rate"]
QUANT_FEATURES = ["repeat_count_ratio", "count_lag1_autocorr"]
CLICK_FEATURES = ["time_to_click_ms", "dwell_ms", "radial_offset", "offset_bias_x", "offset_bias_y", "target_distance"]

# Everything a per-segment model may train on (before the hardware-block
# leakage experiment layers HARDWARE_COLUMNS on or off).
FEATURE_COLUMNS = (
    BALLISTIC_FEATURES + SMOOTHNESS_FEATURES + PATH_FEATURES
    + TREMOR_FEATURES + QUANT_FEATURES + CLICK_FEATURES
)

HARDWARE_COLUMNS = ["dpi", "sens", "cm_per_360", "fov_deg", "refresh_hz", "poll_hz"]

IDENTITY_COLUMNS = [
    "segment_id", "session_id", "subject_id",
    "is_human", "subject_kind", "subject_cohort",
    "routine", "difficulty", "outcome",
    # Carried for the biometric enrol/verify split (sessions ordered by day).
    # Filtered by presence in build_segment_features, so fixtures without it are
    # unaffected.
    "session_started_at",
]

# Emitted alongside the features but not themselves model inputs: the Fitts
# regression (subject level) needs the (amplitude, target size) of each click.
FITTS_COLUMNS = ["angular_amplitude", "angular_target_size"]

# The 8-12 Hz physiological-tremor band (model/DESIGN.md, plan).
TREMOR_BAND_HZ = (8.0, 12.0)


def _coerce_json(value):
    """A nested column arrives either native (dict/list, straight from the
    pull) or as a string (JSON, or a Python repr() if it survived a to_csv()).
    json.loads handles the first string form; ast.literal_eval the repr form
    with its single quotes that json rejects."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return ast.literal_eval(value)
    raise TypeError(f"cannot coerce {type(value)} into a nested column")


def _num(value):
    if value is None:
        return np.nan
    if isinstance(value, float) and math.isnan(value):
        return np.nan
    return float(value)


# ---------------------------------------------------------------------------
# Per-segment feature blocks
# ---------------------------------------------------------------------------
def _speed_profile(trajectory: dict):
    """Angular speed per inter-frame step, plus the unwrapped yaw/pitch and the
    frame times, so several features can share one pass. Returns (speed, t_mid,
    yaw_u, pitch_u) or None when the segment is too short to differentiate."""
    t = np.asarray(trajectory["t"], dtype=float)
    yaw = np.asarray(trajectory["yaw"], dtype=float)
    pitch = np.asarray(trajectory["pitch"], dtype=float)
    if len(t) < 2:
        return None
    yaw_u = np.unwrap(yaw)
    dt = np.diff(t)
    safe_dt = np.where(dt == 0, np.nan, dt)
    dyaw = np.diff(yaw_u)
    dpitch = np.diff(pitch)
    with np.errstate(invalid="ignore", divide="ignore"):
        speed = np.sqrt(dyaw**2 + dpitch**2) / safe_dt
    if np.all(np.isnan(speed)):
        return None
    t_mid = (t[:-1] + t[1:]) / 2.0
    return speed, t_mid, yaw_u, pitch


def _ballistic(trajectory: dict, prof) -> dict:
    out = {k: np.nan for k in BALLISTIC_FEATURES}
    if prof is None:
        return out
    speed, t_mid, yaw_u, pitch = prof

    out["peak_angular_speed"] = float(np.nanmax(speed))

    # Time-to-peak as a fraction of the movement (humans peak early ~0.4,
    # symmetric synthetic easing peaks ~0.5).
    peak_i = int(np.nanargmax(speed))
    span = t_mid[-1] - t_mid[0]
    out["time_to_peak_fraction"] = float((t_mid[peak_i] - t_mid[0]) / span) if span > 0 else np.nan

    # Skew of the speed profile — human profiles are asymmetric (fast rise,
    # long correcting tail), symmetric bots ~0.
    finite = speed[np.isfinite(speed)]
    if len(finite) >= 3 and np.std(finite) > 0:
        out["velocity_skew"] = float(np.mean(((finite - finite.mean()) / finite.std()) ** 3))

    # Submovement count: local maxima in the speed profile. Naive snap = 1;
    # a human flick has a ballistic peak + ≥1 corrective submovement
    # (validated by the USPTO submovement patent). A tiny prominence gate
    # keeps sensor noise from inflating the count.
    out["submovement_count"] = float(_count_submovements(speed))
    return out


def _count_submovements(speed: np.ndarray) -> int:
    s = speed[np.isfinite(speed)]
    if len(s) < 3:
        return 1 if len(s) >= 1 else 0
    peak = np.nanmax(s)
    if peak <= 0:
        return 0
    prominence = 0.10 * peak  # ignore ripples under 10% of the peak
    count = 0
    for i in range(1, len(s) - 1):
        if s[i] >= s[i - 1] and s[i] > s[i + 1] and s[i] >= prominence:
            count += 1
    # A monotone single move registers no interior local max; call it one.
    return max(count, 1)


def _smoothness(prof) -> dict:
    out = {k: np.nan for k in SMOOTHNESS_FEATURES}
    if prof is None:
        return out
    speed, t_mid, _, _ = prof
    s = speed[np.isfinite(speed)]
    if len(s) >= 2:
        out["jerk_std"] = float(np.nanstd(np.diff(s)))
    out["sparc"] = float(_sparc(s))
    return out


def _sparc(speed: np.ndarray) -> float:
    """Spectral arc length — the standard noise-robust smoothness metric
    (Balasubramanian et al. 2015). More negative = less smooth. Computed on
    the normalized speed magnitude spectrum."""
    s = speed[np.isfinite(speed)]
    if len(s) < 4 or np.max(s) <= 0:
        return np.nan
    mag = np.abs(np.fft.rfft(s))
    if mag[0] == 0:
        return np.nan
    mag = mag / mag[0]
    freq = np.linspace(0, 1, len(mag))
    arc = np.sum(np.sqrt(np.diff(freq) ** 2 + np.diff(mag) ** 2))
    return float(-arc)


def _path(trajectory: dict, prof) -> dict:
    out = {k: np.nan for k in PATH_FEATURES}
    on = np.asarray(trajectory["on"], dtype=float)
    out["on_target_ratio"] = float(np.mean(on)) if len(on) else np.nan
    # How abruptly the crosshair first lands on target: 1.0 = snapped on in a
    # single frame from off-target (bot-like), lower = swept in across frames.
    if len(on) >= 2 and on.max() > 0:
        first_on = int(np.argmax(on > 0))
        out["on_entry_abruptness"] = 1.0 if first_on == 0 else float(1.0 / (first_on + 1))

    if prof is not None:
        _, _, yaw_u, pitch = prof
        dyaw = np.diff(yaw_u)
        dpitch = np.diff(pitch)
        path_len = float(np.nansum(np.sqrt(dyaw**2 + dpitch**2)))
        net = float(math.hypot(yaw_u[-1] - yaw_u[0], pitch[-1] - pitch[0]))
        out["straightness"] = (net / path_len) if path_len > 0 else np.nan
    return out


def _tremor(input_events: dict | None) -> dict:
    out = {k: np.nan for k in TREMOR_FEATURES}
    if input_events is None:
        return out
    dx = np.asarray(input_events["dx"], dtype=float)
    dy = np.asarray(input_events["dy"], dtype=float)
    t_ms = np.asarray(input_events["t_ms"], dtype=float)
    n = len(dx)
    if n < 8:
        return out

    # Direction reversals — micro-correction jitter, cheap and robust.
    rev = int(np.sum(np.diff(np.sign(dx)) != 0)) + int(np.sum(np.diff(np.sign(dy)) != 0))
    out["reversal_rate"] = rev / (2.0 * n)

    # 8-12 Hz band power of the speed magnitude, from the ~1 kHz raw stream
    # (NOT the per-frame trajectory — at 60-240 Hz tremor aliases away). Needs
    # a roughly regular sample rate; estimate it from the median gap.
    gaps = np.diff(t_ms)
    med = np.median(gaps[gaps > 0]) if np.any(gaps > 0) else 0.0
    if med <= 0:
        return out
    fs = 1000.0 / med  # samples per second
    speed = np.sqrt(dx**2 + dy**2)
    speed = speed - speed.mean()
    spec = np.abs(np.fft.rfft(speed)) ** 2
    freqs = np.fft.rfftfreq(n, d=1.0 / fs)
    total = spec.sum()
    if total <= 0:
        return out
    band = (freqs >= TREMOR_BAND_HZ[0]) & (freqs <= TREMOR_BAND_HZ[1])
    out["tremor_band_power"] = float(spec[band].sum() / total)
    return out


def _quantization(input_events: dict | None) -> dict:
    """Integer device-count micro-structure. A real optical sensor emits a
    granular stream; a bot computing a float aim vector and rounding leaves
    runs of identical counts and smooth ramps (Cursor Insight note). Both
    measures are on the raw integer dx/dy, so they are sensitivity/DPI-free."""
    out = {k: np.nan for k in QUANT_FEATURES}
    if input_events is None:
        return out
    dx = np.asarray(input_events["dx"], dtype=float)
    dy = np.asarray(input_events["dy"], dtype=float)
    n = len(dx)
    if n < 3:
        return out
    # Fraction of consecutive samples with an identical (dx, dy) pair.
    same = np.sum((np.diff(dx) == 0) & (np.diff(dy) == 0))
    out["repeat_count_ratio"] = float(same / (n - 1))
    # Lag-1 autocorrelation of the count magnitude — smooth ramps autocorrelate
    # high, sensor noise low.
    mag = np.sqrt(dx**2 + dy**2)
    if np.std(mag) > 0 and n >= 3:
        a = mag[:-1] - mag[:-1].mean()
        b = mag[1:] - mag[1:].mean()
        denom = math.sqrt(np.sum(a**2) * np.sum(b**2))
        out["count_lag1_autocorr"] = float(np.sum(a * b) / denom) if denom > 0 else np.nan
    return out


def _click_and_fitts(row: pd.Series, prof) -> dict:
    out = {}
    for col in CLICK_ONLY_COLUMNS:
        out[col] = _num(row.get(col))  # pass through — NaN off click rows, never imputed

    ox, oy = out["click_offset_x"], out["click_offset_y"]
    out["radial_offset"] = math.hypot(ox, oy) if not (math.isnan(ox) or math.isnan(oy)) else np.nan
    out["offset_bias_x"] = ox
    out["offset_bias_y"] = oy
    out["target_distance"] = _num(row.get("target_distance"))

    # Fitts inputs (used at the subject level, not as per-segment model
    # features): amplitude = angular path actually traveled; target angular
    # size ~ 2*r/distance (small-angle). r comes from the engaged target.
    amplitude = np.nan
    if prof is not None:
        _, _, yaw_u, pitch = prof
        amplitude = float(math.hypot(yaw_u[-1] - yaw_u[0], pitch[-1] - pitch[0]))
    out["angular_amplitude"] = amplitude

    tgt_size = np.nan
    targets = _coerce_json(row.get("targets"))
    engaged = row.get("engaged_index")
    dist = out["target_distance"]
    if targets and engaged is not None and not math.isnan(dist) and dist > 0:
        try:
            r = float(targets[int(engaged)]["r"])
            tgt_size = 2.0 * r / dist
        except (KeyError, IndexError, TypeError, ValueError):
            tgt_size = np.nan
    out["angular_target_size"] = tgt_size
    return out


def _segment_features(row: pd.Series) -> dict:
    trajectory = _coerce_json(row["trajectory"])
    input_events = _coerce_json(row.get("input_events"))
    prof = _speed_profile(trajectory)

    feats = {}
    feats.update(_ballistic(trajectory, prof))
    feats.update(_smoothness(prof))
    feats.update(_path(trajectory, prof))
    feats.update(_tremor(input_events))
    feats.update(_quantization(input_events))
    feats.update(_click_and_fitts(row, prof))
    return feats


def build_segment_features(df: pd.DataFrame) -> pd.DataFrame:
    """One decoded segment row in, one feature row out."""
    rows = [_segment_features(row) for _, row in df.iterrows()]
    feats = pd.DataFrame(rows, index=df.index)

    keep = [c for c in IDENTITY_COLUMNS + HARDWARE_COLUMNS if c in df.columns]
    result = pd.concat([df[keep], feats], axis=1)

    missing = [c for c in FEATURE_COLUMNS + FITTS_COLUMNS if c not in result.columns]
    if missing:
        raise RuntimeError(f"build_segment_features is missing column(s) {missing}")
    return result


# ---------------------------------------------------------------------------
# Per-subject aggregates
# ---------------------------------------------------------------------------
def _fitts_fit(sub: pd.DataFrame) -> tuple[float, float]:
    """Regress time_to_click_ms on the index of difficulty across a subject's
    click segments. Returns (slope, residual_std). Humans fit with a positive
    slope and a tight residual; a snap bot is flat, a constant-velocity bot is
    linear in amplitude rather than in log difficulty, inflating the residual."""
    d = sub.dropna(subset=["time_to_click_ms", "angular_amplitude", "angular_target_size"])
    d = d[(d["angular_amplitude"] > 0) & (d["angular_target_size"] > 0)]
    if len(d) < 4:
        return np.nan, np.nan
    idx = np.log2(2.0 * d["angular_amplitude"].to_numpy() / d["angular_target_size"].to_numpy())
    mt = d["time_to_click_ms"].to_numpy()
    if np.std(idx) == 0:
        return np.nan, np.nan
    slope, intercept = np.polyfit(idx, mt, 1)
    resid = mt - (slope * idx + intercept)
    return float(slope), float(np.std(resid))


def build_subject_features(seg: pd.DataFrame) -> pd.DataFrame:
    """One row per subject: Fitts conformance, reaction-time floor/shape, and
    the coefficient of variation of the per-segment features (the "too
    consistent" signal). `seg` is build_segment_features output."""
    agg_rows = []
    for subject_id, sub in seg.groupby("subject_id"):
        row = {"subject_id": subject_id}
        for col in ["is_human", "subject_kind", "subject_cohort"]:
            if col in sub.columns:
                row[col] = sub[col].iloc[0]

        slope, resid = _fitts_fit(sub)
        row["fitts_slope"] = slope
        row["fitts_residual_std"] = resid

        rt = sub["time_to_click_ms"].dropna().to_numpy()
        if len(rt) >= 5:
            row["rt_floor_ms"] = float(np.percentile(rt, 5))
            if np.std(rt) > 0:
                row["rt_skew"] = float(np.mean(((rt - rt.mean()) / rt.std()) ** 3))
            else:
                row["rt_skew"] = 0.0
        else:
            row["rt_floor_ms"] = np.nan
            row["rt_skew"] = np.nan

        # CV (std/|mean|) of each per-segment feature — low = suspiciously
        # consistent. Guard the zero-mean case.
        for col in FEATURE_COLUMNS:
            vals = sub[col].dropna().to_numpy()
            if len(vals) >= 3 and abs(np.mean(vals)) > 1e-9:
                row[f"cv_{col}"] = float(np.std(vals) / abs(np.mean(vals)))
            else:
                row[f"cv_{col}"] = np.nan
        agg_rows.append(row)

    return pd.DataFrame(agg_rows)


SUBJECT_FEATURE_COLUMNS = (
    ["fitts_slope", "fitts_residual_std", "rt_floor_ms", "rt_skew"]
    + [f"cv_{c}" for c in FEATURE_COLUMNS]
)


# ---------------------------------------------------------------------------
# CLI — the `--in`/`--out` stage from model/DESIGN.md's planned commands.
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Flatten decoded segments into feature tables.")
    ap.add_argument("--in", dest="in_path", required=True,
                    help="decoded-segments parquet from fetch_telemetry.py")
    ap.add_argument("--out", required=True, help="per-segment feature parquet")
    ap.add_argument("--subject-out", default=None,
                    help="optional per-subject aggregate feature parquet")
    args = ap.parse_args()

    df = pd.read_parquet(args.in_path)
    seg = build_segment_features(df)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    seg.to_parquet(out, index=False)
    print(f"Wrote {len(seg)} segment-feature rows to {out}")

    if args.subject_out:
        subj = build_subject_features(seg)
        subj_out = Path(args.subject_out)
        subj_out.parent.mkdir(parents=True, exist_ok=True)
        subj.to_parquet(subj_out, index=False)
        print(f"Wrote {len(subj)} subject-feature rows to {subj_out}")


if __name__ == "__main__":
    main()
