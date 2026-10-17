import { Euler, Raycaster, Vector2, Vector3 } from 'three';
import { createRoutine } from './routines/index.js';
import { configFor } from './difficulty.js';
import { createTelemetry, buildSegmentPayload, buildSessionPayload } from './telemetry.js';
import { insertSession, insertSegment } from './supabase.js';
import {
  FEEDBACK_FLASH_MS,
  TRACK_WINDOW_MS,
  DEFAULT_ROUTINE,
  DEFAULT_DIFFICULTY,
  SESSION_COMPLETE_FRACTION
} from './constants.js';

const SCREEN_CENTER = new Vector2(0, 0);
const WORLD_UP = new Vector3(0, 1, 0);

// Scratch objects, reused so a click allocates nothing.
const _forward = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _point = new Vector3();
const _intersections = [];
// YXZ so .y is yaw and .x is pitch, matching how the camera is rotated.
const _euler = new Euler(0, 0, 0, 'YXZ');

function round3(value) {
  return Math.round(value * 1e3) / 1e3;
}

// A client-minted session uuid. The session id is generated HERE, at start(),
// rather than returned by the insert, so a segment can be enqueued the instant
// it closes (it already knows the id) and a failed session insert cannot discard
// the run. crypto.randomUUID() in any modern browser or Node; the fallback keeps
// the headless harness and any old runtime working. A collision is astronomically
// unlikely and would merely raise 23505, which the outbox settles.
function newSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Hosts whichever routine is active: it owns the session, the raycast, the HUD
// counters and telemetry, and asks the routine what to do with a hit or a miss.
//
// A session is one TIMED RUN, not one pointer lock: pause()/resume() bracket the
// locks inside it. Everything downstream of update() runs on the play clock
// (`now - pausedTotalMs`), so paused time is invisible to the routines, to the
// telemetry, and to the countdown. onExpire fires when the run's time is up.
export function createGame({ scene, camera, crosshair, hud, onExpire = () => {} }) {
  const raycaster = new Raycaster();
  const telemetry = createTelemetry();

  let routine = null;
  let running = false;
  // The DB session id, minted on the client in start() (see newSessionId). Every
  // segment carries it directly, so a segment is enqueued synchronously the
  // moment it closes — no promise to await, and no dependency on the session
  // insert having resolved. null between runs.
  let currentSessionId = null;
  let sessionStartMs = 0;
  // Resets ONLY in start(), which also mints a fresh session id. Never reset it
  // on resume: a re-used index collides with a pre-pause row on the unique
  // (session_id, segment_index), and the outbox cannot tell that collision apart
  // from a redelivery — it reads 23505 as "already landed" and settles the row.
  // So the whole post-resume half of the session vanishes with no error, no
  // warning and no retry.
  let segmentIndex = 0;
  let routineId = DEFAULT_ROUTINE;
  let difficulty = DEFAULT_DIFFICULTY;
  let kind = 'destructible';
  let attemptStart = 0;
  let dwellStart = 0;
  // Index of the engaged target within the segment's `targets` snapshot,
  // captured at segment start and shipped with the row. Not hardcoded: the
  // moment a routine's aimTarget() stops being targets[0] a hardcoded 0 would
  // silently mislabel every row with no error.
  let engagedIndexAtStart = null;
  // Raw mouse counts accumulated between rendered frames, flushed into one
  // sample per frame so the trajectory has a steady cadence.
  let pendingDx = 0;
  let pendingDy = 0;
  // The run's clock. `pausedTotalMs` is subtracted from every raw timestamp to
  // give the play clock, which is what makes pausing work at all: each routine
  // holds its own deadline in the timestamps it was handed (spidershot's
  // expiresAt, strafing's nextChangeAt), so a raw clock after a pause would
  // expire a target the instant the player resumes.
  let plannedDurationMs = 0;
  let pausedTotalMs = 0;
  let pauseStartedAt = 0;
  // Active-play elapsed, frozen when the run stops, for the summary.
  let endedAtMs = 0;
  // Whether the open segment holds frames that have not been shipped. Guards
  // against pause() and end() both flushing the same buffer: flushSegment()
  // does not clear it (only beginAttempt() replaces it), so a pause followed by
  // "Back to menu" would otherwise ship identical frames twice under two
  // different segment_index values — legal rows no constraint catches.
  let segmentOpen = false;
  let flashTimer = 0;
  let hits = 0;
  let attempts = 0;
  let clicks = 0;
  let totalTimeMs = 0;

  function pushHud() {
    hud.update({ hits, attempts, clicks, totalTimeMs });
  }

  // Raw performance.now() -> play clock. The only conversion in the module.
  function play(rawNow) {
    return rawNow - pausedTotalMs;
  }

  // The camera's absolute yaw/pitch, read off the camera quaternion — so
  // telemetry is DPI-independent, comparable across sensitivities and users.
  function cameraAngles() {
    _euler.setFromQuaternion(camera.quaternion, 'YXZ');
    return { yaw: _euler.y, pitch: _euler.x };
  }

  // Cast the crosshair ray at the current aim and return the nearest live
  // target hit, or null. Three only recomposes the camera's world matrix during
  // render(), so recompose it here or the ray reflects last frame's aim.
  function raycastCenter() {
    camera.updateMatrixWorld();
    raycaster.setFromCamera(SCREEN_CENTER, camera);
    _intersections.length = 0;
    raycaster.intersectObjects(routine.targets, false, _intersections);
    return _intersections.length > 0 ? _intersections[0] : null;
  }

  // The engaged target is the one whose position each frame records — for a
  // single-target routine it is simply the target.
  function engagedTarget() {
    return routine.aimTarget();
  }

  function engagedDistance() {
    const engaged = engagedTarget();
    return engaged === null ? null : camera.position.distanceTo(engaged.position);
  }

  // The layout of every live target at the start of a segment: positions and
  // radii, so target selection and the ignored targets can be studied later.
  function snapshotBoard() {
    return routine.targets.map((target) => ({
      x: round3(target.position.x),
      y: round3(target.position.y),
      z: round3(target.position.z),
      r: target.userData.radius
    }));
  }

  // One telemetry sample per rendered frame: the player's aim and the world
  // state together, so tracking error is recoverable for every routine.
  function sampleFrame(now, dx, dy) {
    const { yaw, pitch } = cameraAngles();
    const engaged = engagedTarget();
    const on = raycastCenter() !== null;

    // dwell_ms is the span from the crosshair first settling on a target until
    // the click, so it is stamped the first frame contact is made.
    if (on && dwellStart === 0) dwellStart = now;

    telemetry.sample(now, {
      dx,
      dy,
      yaw,
      pitch,
      tx: engaged === null ? null : engaged.position.x,
      ty: engaged === null ? null : engaged.position.y,
      tz: engaged === null ? null : engaged.position.z,
      on
    });
  }

  // A segment is one row. It opens on spawn/re-arm, on a click, or on a window
  // boundary, and always begins with a fresh board snapshot and buffer.
  function beginAttempt(now) {
    attemptStart = now;
    dwellStart = 0;
    segmentOpen = true;

    // Capture which target in the snapshot is the engaged one, before any of
    // this segment's frames are sampled. targets is the routine's live active
    // array, which snapshotBoard() records in order, so the index lines up.
    const engaged = engagedTarget();
    const index = engaged === null ? -1 : routine.targets.indexOf(engaged);
    engagedIndexAtStart = index === -1 ? null : index;

    telemetry.beginSegment(now, snapshotBoard());
  }

  // Ships the segment that just closed. The frames/board references are read
  // before beginAttempt() swaps in fresh ones, so an in-flight insert keeps its
  // own array. An empty segment (no frame sampled yet) is never shipped.
  function flushSegment(outcome, fields = {}) {
    const frames = telemetry.frames();
    if (frames.length === 0) return;

    // Shipped: the buffer is now spoken for. Only beginAttempt() reopens one.
    segmentOpen = false;

    // The targets snapshot taken at segment start — feeds `targets` and
    // `target_count`. (Not the removed per-frame board_trajectory.)
    const board = telemetry.board();
    const inputs = telemetry.inputs();
    const {
      targetDistance = null,
      timeToClickMs = null,
      dwellMs = null,
      clickOffset = null
    } = fields;

    insertSegment(
      currentSessionId,
      buildSegmentPayload({
        segmentIndex: segmentIndex++,
        startedAtMs: Math.round(attemptStart - sessionStartMs),
        outcome,
        targetDistance,
        timeToClickMs,
        dwellMs,
        clickOffset,
        targetCount: board.length,
        targets: board,
        engagedIndex: engagedIndexAtStart,
        frames,
        inputs,
        // Static-target routines omit per-frame tx/ty/tz (sampling_version 4);
        // `strafing` declares movesTargets and depends on this being kept.
        movesTargets: routine.movesTargets === true
      })
    );
  }

  function flash(result) {
    crosshair.classList.remove('hit', 'miss');
    crosshair.classList.add(result);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => crosshair.classList.remove(result), FEEDBACK_FLASH_MS);
  }

  // Click offset from target center, measured on the plane perpendicular to the
  // camera-to-target vector, in world units. Targets are never rotated or
  // scaled, so their local axes stay world-aligned.
  function computeClickOffset(target, worldPoint) {
    _forward.subVectors(target.position, camera.position).normalize();
    _right.crossVectors(_forward, WORLD_UP).normalize();
    _up.crossVectors(_right, _forward).normalize();

    _point.copy(worldPoint);
    target.worldToLocal(_point);

    return { x: _point.dot(_right), y: _point.dot(_up) };
  }

  // A miss reports the closest target that was on screen rather than nothing.
  function nearestTargetDistance() {
    let nearest = null;

    for (const target of routine.targets) {
      const distance = camera.position.distanceTo(target.position);
      if (nearest === null || distance < nearest) nearest = distance;
    }

    return nearest;
  }

  // A click in a destructible routine: closes the current segment as hit or
  // miss and re-arms the next.
  function shoot(now) {
    const timeToClickMs = Math.round(now - attemptStart);
    // Null when the crosshair never touched a target this attempt (a pure
    // miss, or a click before settling on one).
    const dwellMs = dwellStart === 0 ? null : Math.round(now - dwellStart);

    const struck = raycastCenter();
    const isHit = struck !== null;
    const targetDistance = isHit
      ? camera.position.distanceTo(struck.object.position)
      : nearestTargetDistance();
    const clickOffset = isHit ? computeClickOffset(struck.object, struck.point) : null;

    // Resolve and re-arm first — everything below is off the latency path.
    flash(isHit ? 'hit' : 'miss');
    if (isHit) routine.resolveHit(struck.object, now);
    else routine.resolveMiss(now);

    flushSegment(isHit ? 'hit' : 'miss', { targetDistance, timeToClickMs, dwellMs, clickOffset });
    beginAttempt(now);

    attempts += 1;
    clicks += 1;
    if (isHit) hits += 1;
    totalTimeMs += timeToClickMs;
    pushHud();
  }

  // A click in a tracking routine gives feedback and an on-target score, but
  // does not end a segment (segments are time-windowed) or write a row.
  function trackingShot(now) {
    const isHit = raycastCenter() !== null;
    flash(isHit ? 'hit' : 'miss');

    attempts += 1;
    if (isHit) hits += 1;
    pushHud();
  }

  // Pointer events (not mouse events) expose getCoalescedEvents(): the raw
  // sub-frame samples the browser merged into this one, at the native poll rate.
  // Each is accumulated into the per-frame trajectory AND recorded individually
  // into the segment's input stream, whose finer timing the frame sampler loses.
  // The coalesced deltas sum to the merged event's, so trajectory dx/dy are
  // unchanged; the fallback covers browsers without the API.
  function onPointerMove(event) {
    const coalesced =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null;

    // event.timeStamp is on the raw performance.now() epoch, but telemetry.js
    // subtracts a play-clock segment start from it — so it has to be converted
    // here too, or every input_events.t is silently offset by the paused total.
    if (coalesced !== null && coalesced.length > 0) {
      for (const sample of coalesced) {
        pendingDx += sample.movementX;
        pendingDy += sample.movementY;
        telemetry.recordInput(play(sample.timeStamp), sample.movementX, sample.movementY);
      }
      return;
    }

    pendingDx += event.movementX;
    pendingDy += event.movementY;
    telemetry.recordInput(play(event.timeStamp), event.movementX, event.movementY);
  }

  function onMouseDown(event) {
    if (running === false || event.button !== 0) return;

    const now = play(performance.now());
    if (kind === 'tracking') trackingShot(now);
    else shoot(now);
  }

  document.addEventListener('mousedown', onMouseDown);

  return {
    update(now) {
      if (running === false) return;

      // Everything below runs on the play clock, never on `now`.
      const t = play(now);
      const elapsed = t - sessionStartMs;

      // Checked first, and the ordering is load-bearing rather than stylistic:
      // onExpire() calls back into end(), which disposes the target pool, so
      // `running` must be cleared before notifying and nothing below may touch
      // routine.* afterwards. Past the deadline nothing may spawn or ship.
      if (plannedDurationMs > 0 && elapsed >= plannedDurationMs) {
        running = false;
        // Frozen here, not in end(): end() can no longer tell that the run was
        // live, and a stale endedAtMs would report a finished run as 0 played.
        endedAtMs = elapsed;
        onExpire();
        return;
      }

      hud.setTimeLeft(Math.ceil((plannedDurationMs - elapsed) / 1000));

      const events = routine.update(t);
      if (events.expired > 0) {
        // The clock took the target. It counts against accuracy, and its search
        // trajectory is a labeled failure worth keeping — so the segment is
        // shipped as a timeout before re-arming, without counting a click.
        attempts += events.expired;
        flushSegment('timeout');
        beginAttempt(t);
        pushHud();
      }

      const dx = pendingDx;
      const dy = pendingDy;
      pendingDx = 0;
      pendingDy = 0;
      sampleFrame(t, dx, dy);

      // Tracking has no click to end a segment, so cut it into fixed windows:
      // one row per window keeps the buffer bounded and the rows uniform.
      if (kind === 'tracking' && t - attemptStart >= TRACK_WINDOW_MS) {
        flushSegment('track', { targetDistance: engagedDistance() });
        beginAttempt(t);
      }
    },

    // Opens a new timed run. A fresh routine is built per session, so a mode or
    // difficulty change on the home screen always takes effect on the next one.
    start(options = {}) {
      routineId = options.routineId ?? DEFAULT_ROUTINE;
      difficulty = options.difficulty ?? DEFAULT_DIFFICULTY;
      const config = options.config ?? configFor(routineId, difficulty);

      if (routine !== null) routine.stop();
      routine = createRoutine(routineId, { scene, camera, config });
      kind = routine.kind ?? 'destructible';

      plannedDurationMs = options.plannedDurationMs ?? 0;
      // Raw and play clocks coincide at start, since nothing is paused yet.
      pausedTotalMs = 0;
      pauseStartedAt = 0;
      endedAtMs = 0;
      segmentOpen = false;

      const now = performance.now();
      sessionStartMs = now;
      segmentIndex = 0;

      // Mint the session id here and open the session row with it. insertSession
      // is fire-and-forget (durable: it queues to its own outbox and retries), so
      // nothing blocks the game loop and a transient failure no longer loses the
      // run. options.session carries the hardware block (dpi/sens/cm360, fov,
      // refresh, device) from main.js. The id is NOT regenerated on pause/resume:
      // one run is one session row.
      currentSessionId = newSessionId();
      insertSession(
        buildSessionPayload({
          id: currentSessionId,
          routine: routineId,
          difficulty,
          routineConfig: config,
          plannedDurationMs,
          ...(options.session ?? {})
        })
      );

      hits = 0;
      attempts = 0;
      clicks = 0;
      totalTimeMs = 0;
      pendingDx = 0;
      pendingDy = 0;
      pushHud();
      hud.setTimeLeft(Math.ceil(plannedDurationMs / 1000));

      running = true;
      document.addEventListener('pointermove', onPointerMove);

      routine.start(now);
      beginAttempt(now);
    },

    // Pointer lock lost. The run is suspended, not ended: the clock freezes and
    // resume() picks the same session up where it left off.
    pause() {
      if (running === false) return;

      running = false;
      pauseStartedAt = performance.now();
      endedAtMs = play(pauseStartedAt) - sessionStartMs;
      // Counts accumulated since the last rendered frame belong to play that
      // already happened; letting them land on the first resumed frame would
      // record a phantom jump across the seam.
      pendingDx = 0;
      pendingDy = 0;
      document.removeEventListener('pointermove', onPointerMove);

      // A tracking window in progress is a legitimate `track` row — same flush
      // the old stop() did. A destructible attempt in progress is NOT: it has no
      // outcome, and closing it as 'timeout' would fabricate a failed attempt
      // (and make timeout reachable for flick, where it cannot occur). It is
      // discarded — resume()'s beginAttempt() allocates fresh buffers.
      if (kind === 'tracking' && segmentOpen) {
        flushSegment('track', { targetDistance: engagedDistance() });
      }
    },

    // Pointer lock regained. Absorbs the pause into the offset so the play clock
    // continues exactly where it stopped.
    resume() {
      if (running === true || routine === null) return;

      pausedTotalMs += performance.now() - pauseStartedAt;
      running = true;
      document.addEventListener('pointermove', onPointerMove);
      // segmentIndex and currentSessionId are deliberately untouched.
      beginAttempt(play(performance.now()));
    },

    // Ends the run for good and returns its summary, or null if already ended.
    end() {
      if (routine === null) return null;

      // Only a still-running run needs its clock read: pause() froze endedAtMs,
      // and so did the expiry branch in update(), which has already cleared
      // `running` by the time it calls back in here.
      if (running) endedAtMs = play(performance.now()) - sessionStartMs;
      running = false;
      // A no-op when pause() already removed it.
      document.removeEventListener('pointermove', onPointerMove);

      // segmentOpen — not "was it running" — is what stops the same buffer
      // shipping twice: flushSegment() does not clear it, so a pause that
      // already shipped this window leaves nothing here to ship.
      if (kind === 'tracking' && segmentOpen) {
        flushSegment('track', { targetDistance: engagedDistance() });
      }

      routine.stop();
      routine = null;
      hud.setTimeLeft(0);

      const activeMs = Math.max(0, Math.round(endedAtMs));

      return {
        routineId,
        difficulty,
        plannedMs: plannedDurationMs,
        activeMs,
        hits,
        attempts,
        clicks,
        totalTimeMs,
        // Shown to the player as progress, never persisted: the offline verdict
        // is computed from delivered segments and is the only record.
        completed:
          plannedDurationMs > 0 && activeMs >= plannedDurationMs * SESSION_COMPLETE_FRACTION
      };
    },

    // Frozen while paused, because the play clock is.
    remainingMs() {
      const elapsed = running ? play(performance.now()) - sessionStartMs : endedAtMs;
      return Math.max(0, plannedDurationMs - elapsed);
    }
  };
}
