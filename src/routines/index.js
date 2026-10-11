import { createFlickRoutine } from './flick.js';
import { createGridshotRoutine } from './gridshot.js';
import { createSpidershotRoutine } from './spidershot.js';
import { createStrafingRoutine } from './strafing.js';
import { createSwitchingRoutine } from './switching.js';

// The catalogue the home screen renders. For the data-collection campaign this
// is the THREE shipping routines only: one static single-target flick, one
// timed single-target reflex, and one single moving target to track.
export const ROUTINES = [
  {
    id: 'flick',
    name: 'Precision Flick',
    blurb: 'One target at a time. Flick, click, repeat.',
    phase: 1,
    available: true
  },
  {
    id: 'spidershot',
    name: 'Dynamic Reflex',
    blurb: 'One target, on a timer. Hit it before it vanishes.',
    phase: 2,
    available: true
  },
  {
    id: 'strafing',
    name: 'Reactive Strafing',
    blurb: 'Track a target that changes direction without warning.',
    phase: 3,
    available: true
  }
];

// WITHHELD, not deleted. The multi-target routines are kept in the codebase (the
// factories below, their files, and their difficulty.js entries all remain) but
// are absent from ROUTINES, so they never render as a tile and isAvailable()
// never resolves them — settings.js falls any stored value here back to flick.
//
// WHY they are withheld: every routine's aimTarget() returns pool.active[0], an
// ARBITRARY live target, not the one the player is engaging. For a single-target
// routine that is correct by construction. For these two it is not — trajectory
// tx/ty/tz and engaged_index would describe a target the player may not be
// aiming at, and nothing records which target was actually struck. Rather than
// ship plausible-but-wrong rows into an unregenerable dataset, they are held out
// until aimTarget() is made crosshair-aware and struck_index is added. Turning
// one back on is moving its entry up into ROUTINES.
export const RETIRED_ROUTINES = [
  {
    id: 'gridshot',
    name: 'Static Flicking',
    blurb: 'Three to four static targets held on screen.',
    phase: 2,
    available: false
  },
  {
    id: 'switching',
    name: 'Target Switching',
    blurb: 'Several moving targets. Destroy one, acquire the next.',
    phase: 4,
    available: false
  }
];

// Every factory stays registered, so a RETIRED routine can be revived (or an old
// session row's routine id resolved) without code surgery.
const FACTORIES = {
  flick: createFlickRoutine,
  gridshot: createGridshotRoutine,
  spidershot: createSpidershotRoutine,
  strafing: createStrafingRoutine,
  switching: createSwitchingRoutine
};

// Resolves a name from BOTH catalogues, so a HUD label or results screen still
// renders a sensible name for a withheld routine that reached it via old state.
export function routineById(id) {
  return (
    ROUTINES.find((routine) => routine.id === id) ??
    RETIRED_ROUTINES.find((routine) => routine.id === id) ??
    null
  );
}

// Availability consults ROUTINES ONLY — this is what makes a withheld routine
// unreachable. It also still requires a registered factory, so a listed routine
// with no implementation stays gated.
export function isAvailable(id) {
  const routine = ROUTINES.find((r) => r.id === id) ?? null;
  return routine !== null && routine.available && FACTORIES[id] !== undefined;
}

// Every routine exposes the same shape: a live `targets` array to raycast
// against, start/update/stop, hit and miss resolution, and aimTarget() — the
// engaged target whose position each telemetry frame records.
export function createRoutine(id, deps) {
  const factory = FACTORIES[id] ?? FACTORIES.flick;
  return factory(deps);
}
