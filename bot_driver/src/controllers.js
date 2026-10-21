// Aim controllers — one per bot variant. Each is a pure function of the current
// ANGULAR error (remaining yaw/pitch, in radians) to the engaged target, and
// returns the angular step {dYaw, dPitch} to turn the camera this frame. The
// harness (run.js) is a closed loop: it reads the real target position and
// camera angles from the game's DEV-only window.__aimbot hook every frame,
// computes the error, asks the controller for a step, converts that step to
// integer mouse movement counts via the game's own sensitivity, and dispatches
// it through the real movementX/movementY path. No screenshots, no pixel CV.
//
// Why angle-space: the bot-detector's features (angular speed, smoothness,
// overshoot, tremor, Fitts) are computed from exactly these per-frame turn
// deltas, so shaping the delta IS the variant. Each variant is a recognisably
// different motor strategy, which is what gives leave-one-cohort-out something
// to generalise across.
//
// Firing is decided by the harness, not here: it fires when the game itself
// reports onTarget (its own crosshair raycast) after a small per-variant
// reaction delay — so a controller never needs hit-test maths.

// Per-frame cap on turn rate (radians/frame at ~60Hz). Sized so a typical flick
// spans several frames (giving each segment a real trajectory to sample), not a
// single-frame teleport.
const MAX_STEP = 0.045;
// Ease-out fraction of the remaining error consumed per frame (smooth/overshoot
// correction phase). 0.22 → exponential approach that decelerates onto target.
const EASE = 0.22;

function mag(err) {
  return Math.hypot(err.yaw, err.pitch);
}

// Unit direction of the error, or zero when already centred.
function dir(err) {
  const m = mag(err);
  return m < 1e-6 ? { yaw: 0, pitch: 0 } : { yaw: err.yaw / m, pitch: err.pitch / m };
}

// Step straight at the target, capped at MAX_STEP per frame — constant angular
// velocity until the last (partial) frame. Reads as a rigid, inhumanly steady
// line.
export function linear(err) {
  const m = mag(err);
  const step = Math.min(m, MAX_STEP);
  const d = dir(err);
  return { dYaw: d.yaw * step, dPitch: d.pitch * step };
}

// Consume a fixed fraction of the remaining error each frame: fast at first,
// decelerating onto the target. Smoother than linear, but with a tell-tale
// perfectly-exponential settle no hand produces.
export function smooth(err) {
  return { dYaw: err.yaw * EASE, dPitch: err.pitch * EASE };
}

// Curved sweep: step along the error direction ROTATED by an angle that is
// largest early in the approach and straightens as it closes — a bezier-like
// arc into the target rather than a straight line. The rotation is kept modest
// so the step always keeps a strong inward (radial) component (cos(0.35)≈0.94)
// and the aim provably converges instead of orbiting. The reference magnitude
// is captured ONCE when the target is acquired (never grown), so `frac`
// decreases monotonically with the error and the arc genuinely straightens.
const CURVE = 0.35; // peak arc rotation in radians (~20°) at the start of a flick
export function bezier(err, state) {
  const m = mag(err);
  if (state.init === undefined) state.init = Math.max(m, 1e-6); // set on acquire only
  const frac = Math.min(1, m / state.init); // 1 far → 0 near
  const theta = CURVE * frac * (state.side ?? 1);
  const d = dir(err);
  const c = Math.cos(theta), s = Math.sin(theta);
  const rot = { yaw: d.yaw * c - d.pitch * s, pitch: d.yaw * s + d.pitch * c };
  const step = Math.min(m, MAX_STEP);
  return { dYaw: rot.yaw * step, dPitch: rot.pitch * step };
}

// Underdamped spring: accelerate toward the target, carry momentum, and damp —
// so the crosshair shoots PAST the target and rings back onto it before
// settling, the classic aimbot-with-humanisation signature. Unlike the smooth
// (ease-out / overdamped) variant it genuinely overshoots, and unlike a hand it
// rings with a fixed frequency. A damped oscillator always settles, so it is
// provably convergent for any target geometry (the earlier discrete two-phase
// version orbited for some geometries). Velocity is held in state, reset by the
// harness per target.
const SPRING_STIFF = 0.28; // pull toward target per frame
const SPRING_DAMP = 0.32;  // velocity bleed per frame (underdamped → overshoots)
const SPRING_CAP = 3 * MAX_STEP; // safety cap on a single frame's turn
export function overshoot(err, state) {
  state.vYaw = (state.vYaw ?? 0) * (1 - SPRING_DAMP) + err.yaw * SPRING_STIFF;
  state.vPitch = (state.vPitch ?? 0) * (1 - SPRING_DAMP) + err.pitch * SPRING_STIFF;
  const clamp = (v) => Math.max(-SPRING_CAP, Math.min(SPRING_CAP, v));
  return { dYaw: clamp(state.vYaw), dPitch: clamp(state.vPitch) };
}

// Linear, plus a small Gaussian tremor added to every frame's step — a crude
// hand-jitter mimic. The tremor is uncorrelated frame to frame, unlike a real
// hand's low-frequency drift, which is itself a detectable tell.
const JITTER = 0.004; // radians stddev of the per-frame tremor
function gauss(rng) {
  // Box-Muller from the injected uniform rng (seedable for reproducibility).
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function jitter(err, state, rng) {
  const base = linear(err);
  return {
    dYaw: base.dYaw + gauss(rng) * JITTER,
    dPitch: base.dPitch + gauss(rng) * JITTER
  };
}

// The HARD one: a deliberate humanlike motor model built to defeat the detector
// across every feature the easy variants fail on at once. It is NOT a tuned
// aimbot — it reproduces the imperfections a real hand has, so a detector that
// still flags it is flagging genuine human-like motion. Three mechanisms:
//
//   1. Two-phase submovement aiming. A fast BALLISTIC primary move with a
//      minimum-jerk (bell-shaped) velocity profile that deliberately UNDERSHOOTS
//      (lands at ~80–92% of the distance, randomised per flick), then one or
//      more slower CORRECTIVE submovements to close the residual. This is the
//      Meyer optimised-submovement picture of human aiming — it fixes
//      submovement_count, time_to_peak_fraction, velocity_skew, sparc,
//      on_entry_abruptness and (via the correction + tremor) reversal_rate,
//      where linear/smooth all read as a single inhuman stroke.
//   2. Physiological tremor: a small CORRELATED 8–12 Hz oscillation applied
//      laterally, not the uncorrelated white noise `jitter` uses. This is what
//      puts power in the real tremor band (tremor_band_power) and gives the
//      count stream human lag-1 autocorrelation (count_lag1_autocorr, jerk_std)
//      instead of jitter's tell-tale ~0 autocorrelation.
//   3. Mild randomised curvature on the ballistic phase (random side, decaying
//      as it closes), so the path is neither dead straight nor a fixed arc
//      (straightness).
//
// Convergence: the ballistic phase commands at most `undershoot·D`; once it ends
// the correction phase always steps a fraction (<1) of the CURRENT error, so the
// aim provably closes for any geometry — the harness convergence guard is never
// tripped by design. Reaction-time variance and click scatter (time_to_click_ms,
// dwell_ms, radial_offset, offset_bias) are added by run.js, not here, because
// they are properties of WHEN the harness fires, not of the per-frame turn.
const HL_TREMOR_W1 = (2 * Math.PI * 9) / 60;   // ~9 Hz at 60 fps
const HL_TREMOR_W2 = (2 * Math.PI * 11.5) / 60; // ~11.5 Hz
export function humanlike(err, state, rng) {
  const u = () => (typeof rng === 'function' ? rng() : Math.random());
  const m = mag(err);

  // Plan the movement once, when the target is acquired (state is reset by the
  // harness per target). Every parameter is randomised so no two flicks are
  // identical — the trial-to-trial variability a real hand has and the easy
  // variants lack.
  if (state.hl === undefined) {
    state.hl = {
      t: 0,
      D: Math.max(m, 1e-6),
      prog: 0, // cumulative min-jerk fraction already commanded
      undershoot: 0.8 + 0.12 * u(), // ballistic lands at 80–92%
      T: 5 + Math.round(4 * u()), // ballistic duration, 5–9 frames
      curve: 0.12 + 0.18 * u(), // peak arc rotation (radians), early-flight only
      side: state.side ?? (u() < 0.5 ? -1 : 1), // harness sets state.side per target
      corrGain: 0.26 + 0.12 * u(), // correction submovement gain (<1 → converges)
      ph1: 2 * Math.PI * u(),
      ph2: 2 * Math.PI * u(),
      tremorAmp: 0.0010 + 0.0010 * u() // 1–2 mrad lateral tremor
    };
  }
  const s = state.hl;
  s.t += 1;
  const d = dir(err);
  let stepYaw;
  let stepPitch;

  if (s.t <= s.T) {
    // Ballistic: advance along the min-jerk position profile f(τ)=10τ³−15τ⁴+6τ⁵
    // (velocity peaks mid-flight), scaled to undershoot·D, with early curvature.
    const tau = Math.min(1, s.t / s.T);
    const f = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5;
    const target = s.undershoot * f;
    const stepMag = Math.max(0, target - s.prog) * s.D;
    s.prog = target;
    const theta = s.curve * (1 - tau) * s.side;
    const c = Math.cos(theta);
    const si = Math.sin(theta);
    stepYaw = (d.yaw * c - d.pitch * si) * stepMag;
    stepPitch = (d.yaw * si + d.pitch * c) * stepMag;
  } else {
    // Correction: close the residual with a slower submovement aimed at the
    // CURRENT error. Gain < 1, so it decelerates onto the target over a few
    // frames — a visible second (and sometimes third) velocity bump.
    const g = s.corrGain * (0.9 + 0.2 * u());
    stepYaw = err.yaw * g;
    stepPitch = err.pitch * g;
  }

  // Correlated lateral tremor (perpendicular to the aim direction), present in
  // both phases. Tiny relative to the target's angular radius, so it textures
  // the trajectory without preventing onTarget.
  const tr = s.tremorAmp * (Math.sin(HL_TREMOR_W1 * s.t + s.ph1) + 0.6 * Math.sin(HL_TREMOR_W2 * s.t + s.ph2));
  stepYaw += -d.pitch * tr;
  stepPitch += d.yaw * tr;

  const cap = 3 * MAX_STEP;
  return {
    dYaw: Math.max(-cap, Math.min(cap, stepYaw)),
    dPitch: Math.max(-cap, Math.min(cap, stepPitch))
  };
}

// variant name → { aim, reactionMs, reactionSdMs? }. reactionMs is the delay
// after the game reports onTarget before the harness fires, so each variant has
// its own click-timing fingerprint. The easy variants use a FIXED delay (zero
// variance — itself a tell); `humanlike` carries reactionSdMs so run.js samples
// a right-skewed (log-normal) reaction per flick, the way a hand does.
export const CONTROLLERS = {
  linear:    { aim: linear,    reactionMs: 20 },
  smooth:    { aim: smooth,    reactionMs: 60 },
  bezier:    { aim: bezier,    reactionMs: 45 },
  overshoot: { aim: overshoot, reactionMs: 35 },
  jitter:    { aim: jitter,    reactionMs: 50 },
  humanlike: { aim: humanlike, reactionMs: 210, reactionSdMs: 70 }
};
