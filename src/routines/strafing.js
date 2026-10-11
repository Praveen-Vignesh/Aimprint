import { Vector3 } from 'three';
import { createTargetPool, spawnTarget } from '../target.js';
import { bounce, clampInside, frameDelta } from './motion.js';

const NO_EVENTS = Object.freeze({ expired: 0 });

// A new heading must differ from the old one by at least this much, or the
// "cut" would be invisible and the drill would read as a drift.
const MIN_TURN_COS = 0.5;
const MAX_DIRECTION_ATTEMPTS = 8;
// Strafes are lateral first: vertical motion is a garnish, not the drill.
const VERTICAL_RATIO = 0.45;

// Reactive strafing: abrupt, unannounced direction changes on a random timer.
// Nothing about the arena triggers them — that is what makes them unreadable.
export function createStrafingRoutine({ scene, camera, config }) {
  const pool = createTargetPool(scene, config.targetRadius);
  const velocity = new Vector3();
  const candidate = new Vector3();

  let lastNow = 0;
  let nextChangeAt = 0;

  function cut() {
    for (let attempt = 0; attempt < MAX_DIRECTION_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      candidate.set(Math.cos(angle), Math.sin(angle) * VERTICAL_RATIO, 0).normalize();

      if (velocity.lengthSq() === 0) break;
      if (candidate.dot(velocity.clone().normalize()) < MIN_TURN_COS) break;
    }

    velocity.copy(candidate).multiplyScalar(config.baseVelocity);
  }

  function scheduleCut(now) {
    const spread = config.dirChangeMaxMs - config.dirChangeMinMs;
    nextChangeAt = now + config.dirChangeMinMs + Math.random() * spread;
  }

  function launch(now) {
    const target = pool.acquire();
    spawnTarget(target, camera.position);
    clampInside(target.position, config.targetRadius);
    velocity.set(0, 0, 0);
    cut();
    scheduleCut(now);
    lastNow = now;
  }

  return {
    // Tracking: the drill is staying on a live target, so telemetry is sampled
    // in fixed time windows rather than per click.
    kind: 'tracking',
    // The target moves, so its per-frame tx/ty/tz must be stored (sampling_version
    // 4 omits those columns for static routines, where the position is constant
    // and already in the `targets` snapshot).
    movesTargets: true,
    targets: pool.active,

    start(now) {
      pool.releaseAll();
      launch(now);
    },

    update(now) {
      const target = pool.active[0];
      if (target === undefined) return NO_EVENTS;

      const dt = frameDelta(now, lastNow);
      lastNow = now;

      if (now >= nextChangeAt) {
        cut();
        scheduleCut(now);
      }

      target.position.addScaledVector(velocity, dt);
      bounce(target.position, velocity, config.targetRadius);

      // The shot is raycast against this position, so it has to be current.
      target.updateMatrixWorld();
      return NO_EVENTS;
    },

    // Hitting a tracking target does not consume it: the drill is staying on it.
    resolveHit() {},

    resolveMiss() {},

    aimTarget() {
      return pool.active[0] ?? null;
    },

    stop() {
      pool.dispose();
    }
  };
}
