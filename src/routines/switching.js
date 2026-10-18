import { Vector3 } from 'three';
import { createTargetPool, spawnTarget } from '../target.js';
import { bounce, clampInside, frameDelta } from './motion.js';

const NO_EVENTS = Object.freeze({ expired: 0 });

// Lateral first, like the strafing drill: the difficulty here is switching
// between targets, not reading depth.
const VERTICAL_RATIO = 0.5;

// Target switching: several targets moving at once. Destroy one and the next
// has to be acquired immediately — the rest never stop while you do it.
export function createSwitchingRoutine({ scene, camera, config }) {
  const pool = createTargetPool(scene, config.targetRadius);

  const spawnOptions = {
    avoid: pool.active,
    minSeparation: config.targetRadius * 3
  };

  let lastNow = 0;

  function launch(target) {
    spawnTarget(target, camera.position, spawnOptions);
    clampInside(target.position, config.targetRadius);

    // Velocity rides on the mesh so a pooled target can be relaunched without
    // allocating, and each one carries its own heading.
    const velocity = target.userData.velocity ?? new Vector3();
    const angle = Math.random() * Math.PI * 2;
    velocity
      .set(Math.cos(angle), Math.sin(angle) * VERTICAL_RATIO, 0)
      .normalize()
      .multiplyScalar(config.speed);
    target.userData.velocity = velocity;
  }

  return {
    kind: 'destructible',
    // Targets move, so per-frame tx/ty/tz is kept (see sampling_version 1).
    movesTargets: true,
    targets: pool.active,
    // NOTE: this routine used to set `tracksBoardTrajectory: true`, which
    // recorded the non-engaged targets' per-frame paths into a
    // `segments.board_trajectory` column. That column has been REMOVED from the
    // schema, since this is the only routine that ever wrote it and it is
    // withheld from the UI. Reviving this routine for data collection means
    // re-adding the column, its shape guard, its lz4 line and its insert grant
    // in schema.sql, plus the sampleBoard/toBoardColumnar plumbing in
    // telemetry.js — otherwise "which target did they switch to" is
    // unrecoverable, which is the whole signal this drill exists to measure.

    start(now) {
      pool.releaseAll();
      for (let i = 0; i < config.concurrentTargets; i++) launch(pool.acquire());
      lastNow = now;
    },

    update(now) {
      const dt = frameDelta(now, lastNow);
      lastNow = now;

      for (const target of pool.active) {
        target.position.addScaledVector(target.userData.velocity, dt);
        bounce(target.position, target.userData.velocity, config.targetRadius);

        // The shot is raycast against these positions, so they have to be current.
        target.updateMatrixWorld();
      }

      return NO_EVENTS;
    },

    resolveHit(target) {
      pool.release(target);
      launch(pool.acquire());
    },

    // Missing costs accuracy; the field carries on regardless.
    resolveMiss() {},

    aimTarget() {
      return pool.active[0] ?? null;
    },

    stop() {
      pool.dispose();
    }
  };
}
