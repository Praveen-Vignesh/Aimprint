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

// variant name → { aim, reactionMs }. reactionMs is the delay after the game
// reports onTarget before the harness fires, so each variant has its own
// click-timing fingerprint too.
export const CONTROLLERS = {
  linear:    { aim: linear,    reactionMs: 20 },
  smooth:    { aim: smooth,    reactionMs: 60 },
  bezier:    { aim: bezier,    reactionMs: 45 },
  overshoot: { aim: overshoot, reactionMs: 35 },
  jitter:    { aim: jitter,    reactionMs: 50 }
};
