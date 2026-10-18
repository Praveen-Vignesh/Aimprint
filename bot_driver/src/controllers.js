// Aim controllers — one per bot variant. Each maps the current pixel offset
// of the target from screen centre to the mouse movement (in integer device
// counts) to dispatch this frame, plus whether to fire. The harness
// (run.js) is a closed loop: it re-reads the offset every frame, so a
// controller never needs the FOV/projection maths — it just drives the error
// toward zero with whatever strategy defines the variant.
//
// THIS SESSION ships `snap` only (the mechanism proof). Variants 2-7 from the
// plan (linear, smoothed, humanized, adversarial, trigger, pursuit) slot in
// here as additional strategies behind the same harness — that is the whole
// reason the loop and the controller are separated.
//
// REALISM REQUIREMENT (from the detection research): every controller must
// return INTEGER counts and drive through the game's real movementX/movementY
// path — never set camera angles. A crude integer snap looks very bot-like,
// which for `snap` is exactly the point.

// Pixels-to-counts gain. The true ratio depends on sensitivity/FOV; the closed
// loop makes an approximate gain fine. `snap` uses a high gain to cross most of
// the distance in one step, like an instant aimbot.
const SNAP_GAIN = 0.9;

function round(v) {
  return Math.sign(v) * Math.round(Math.abs(v));
}

// The engaged-sign of the pixels->movement mapping. The harness can flip this
// at runtime if it observes the error growing (see run.js auto-flip), so a
// wrong initial guess self-corrects in the headed window rather than diverging.
export const DEFAULT_SIGN = 1;

export function snap(offset, sign = DEFAULT_SIGN) {
  // Move almost the whole way to the target in one dispatch.
  const mx = round(sign * SNAP_GAIN * offset.dx);
  const my = round(sign * SNAP_GAIN * offset.dy);
  // Fire once the crosshair is within the target's own radius of its centre.
  const onTarget = Math.hypot(offset.dx, offset.dy) <= Math.max(offset.radiusPx, 4);
  return { mx, my, fire: onTarget };
}

export const CONTROLLERS = { snap };
