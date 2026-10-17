// Per-segment sample buffer and Supabase row assembly. Nothing here talks to
// the network.
//
// A row is one *segment* of play, not one mesh. Destructible routines close a
// segment on a click (hit/miss) or a timeout; tracking routines close one every
// fixed window (see TRACK_WINDOW_MS). Every segment carries a per-frame stream
// of the player's aim *and* the world state, so tracking error is recoverable
// for every mode from one uniform shape.
//
// Session-scoped metadata (hardware, sensitivity, routine) lives on the
// `sessions` row, built once per timed run; per-frame play lives on the
// `segments` rows, one per closed segment. See schema.sql for why the split.
//
// Every timestamp reaching this module is on the PLAY clock — paused time is
// already subtracted by game.js — so nothing here needs to know about pausing.

// Camera pitch/yaw are stored to this many decimal places of a radian
// (~0.0006°); target positions to this many of a world unit (~1 mm). Enough to
// reconstruct the aim and the target path without bloating the row.
const ANGLE_PRECISION = 1e5;
const POSITION_PRECISION = 1e3;
// input_events carry sub-frame timing — the whole reason to record them apart
// from the per-frame trajectory. sampling_version 4 stores each timestamp as an
// INTEGER number of tenths of a millisecond (0.1 ms resolution): fine enough to
// keep ~1 ms poll gaps distinct, but an integer, which is what lets the stream
// be delta-encoded losslessly (see inputsToColumnar — integer cumsum is exact,
// a float cumsum over hundreds of terms would drift). Whole-ms rounding, which
// trajectory `t` still uses, would collapse adjacent 1 ms samples.
const INPUT_TIME_PRECISION = 1e1;

function roundTo(value, precision) {
  return value === null ? null : Math.round(value * precision) / precision;
}

function roundAngle(radians) {
  return roundTo(radians, ANGLE_PRECISION);
}

function roundPos(units) {
  return roundTo(units, POSITION_PRECISION);
}

export function createTelemetry() {
  let frames = [];
  let inputs = [];
  // `board` is the TARGETS SNAPSHOT at segment start (feeds `targets` and
  // `target_count`) — not to be confused with the removed per-frame
  // board_trajectory, which recorded the non-engaged targets' paths.
  let board = [];
  let segmentStart = 0;

  return {
    // Opens a fresh segment. New arrays are allocated rather than emptied in
    // place, because the previous segment's arrays may still be on their way to
    // Supabase. `boardSnapshot` is the layout of every live target at the start
    // of the segment: [{x, y, z, r}].
    beginSegment(timestamp, boardSnapshot) {
      segmentStart = timestamp;
      frames = [];
      inputs = [];
      board = boardSnapshot;
    },

    // One sample per rendered frame. `dx`/`dy` are the raw device counts since
    // the last frame (DPI-dependent); `yaw`/`pitch` are the camera's absolute
    // angles (DPI-independent); `tx`/`ty`/`tz` are the engaged target's world
    // position (null if none); `on` is whether the crosshair sat on any target.
    sample(now, { dx, dy, yaw, pitch, tx, ty, tz, on }) {
      frames.push({
        t: Math.round(now - segmentStart),
        dx,
        dy,
        yaw: roundAngle(yaw),
        pitch: roundAngle(pitch),
        tx: roundPos(tx),
        ty: roundPos(ty),
        tz: roundPos(tz),
        on: on ? 1 : 0
      });
    },

    // One entry per raw pointer sample (getCoalescedEvents), at the native
    // polling rate — sub-frame timing that the per-frame trajectory destroys.
    // `eventTime` is the sample's own DOMHighResTimeStamp, off the same clock as
    // segmentStart, so inter-arrival gaps survive. `t` is stored as an INTEGER
    // number of tenths of a millisecond: rounded to the final resolution HERE,
    // before any delta is taken, so the delta-encode in inputsToColumnar is
    // exact (round-then-delta, never delta-then-round).
    recordInput(eventTime, dx, dy) {
      inputs.push({
        t: Math.round((eventTime - segmentStart) * INPUT_TIME_PRECISION),
        dx,
        dy
      });
    },

    frames() {
      return frames;
    },

    inputs() {
      return inputs;
    },

    board() {
      return board;
    }
  };
}

// Turns the per-frame buffer into the COLUMNAR shape schema.sql stores: parallel
// arrays keyed by field name rather than an array of per-sample objects. Roughly
// a third of the size (no repeated keys) and it loads straight into numpy.
//
// `movesTargets` (sampling_version 4): when false, the engaged target is static
// for the whole segment, so tx/ty/tz is one value repeated frame_count times —
// and that value is already in the segment's `targets` snapshot at
// engaged_index. The three columns are then OMITTED, and the offline reader
// fills them from the snapshot. When true (strafing, switching) the target moves
// and the per-frame positions are the only record, so they are kept.
function toColumnar(frames, movesTargets = false) {
  const n = frames.length;
  const columns = {
    t: new Array(n),
    dx: new Array(n),
    dy: new Array(n),
    yaw: new Array(n),
    pitch: new Array(n),
    on: new Array(n)
  };

  if (movesTargets) {
    columns.tx = new Array(n);
    columns.ty = new Array(n);
    columns.tz = new Array(n);
  }

  for (let i = 0; i < n; i++) {
    const frame = frames[i];
    columns.t[i] = frame.t;
    columns.dx[i] = frame.dx;
    columns.dy[i] = frame.dy;
    columns.yaw[i] = frame.yaw;
    columns.pitch[i] = frame.pitch;
    columns.on[i] = frame.on;
    if (movesTargets) {
      columns.tx[i] = frame.tx;
      columns.ty[i] = frame.ty;
      columns.tz[i] = frame.tz;
    }
  }

  return columns;
}

// Columnar + DELTA-encoded raw input stream (sampling_version 4): {t0, dt, dx,
// dy}, where every t value is an integer number of tenths of a millisecond.
// input.t is already that integer (recordInput rounds before storing), so:
//   t0    = the first sample's absolute time
//   dt[i] = input[i].t - input[i-1].t, with dt[0] defined as 0
// and the reader reconstructs absolute ms as (t0 + cumsum(dt)) / 10. The gaps
// are ~10 (≈1 ms at 1000 Hz), one or two digits each, versus a 4–5 digit
// absolute value — this is the single biggest row in the database and the delta
// cuts it by well over half. len(dt) == n == event_count exactly, which the
// segments_input_events_len_matches CHECK relies on. Decoding happens only in
// the offline archive job, so nothing downstream sees the delta form.
function inputsToColumnar(inputs) {
  const n = inputs.length;
  if (n === 0) return { t0: 0, dt: [], dx: [], dy: [] };

  const dt = new Array(n);
  const dx = new Array(n);
  const dy = new Array(n);
  const t0 = inputs[0].t;
  let prev = t0;

  for (let i = 0; i < n; i++) {
    const input = inputs[i];
    dt[i] = input.t - prev; // dt[0] === 0
    prev = input.t;
    dx[i] = input.dx;
    dy[i] = input.dy;
  }

  return { t0, dt, dx, dy };
}

// Assembles the `sessions` row: everything scoped to one timed run.
// app_version and sampling_version are sent explicitly (not left to the table
// defaults) so a row records the exact code that produced it — the whole point
// of the columns. subject_id is stamped in supabase.js from the resolved
// profile, and `id` is minted by game.js so segments can be enqueued against it
// before the session insert resolves.
//
// poll_hz is DELIBERATELY NOT in the payload. It is service-written (derived
// offline from input_events) and the column-level insert grant in schema.sql
// does not include it — so sending it, even as null, names an ungranted column
// and PostgREST rejects the whole insert with 42501, which the outbox treats as
// permanent and drops. Same reasoning excludes started_at, ended_at and
// bot_mode, which the client never sent anyway. Do not add poll_hz back here.
export function buildSessionPayload({
  id = undefined,
  routine,
  difficulty,
  routineConfig = null,
  plannedDurationMs = null,
  dpi,
  sens,
  cmPer360 = null,
  fovDeg = null,
  refreshHz = null,
  deviceFingerprint = null,
  userAgent = null,
  platform = null,
  screenWidth = null,
  screenHeight = null,
  devicePixelRatio = null,
  appVersion = 'dev',
  samplingVersion = null
}) {
  const payload = {
    routine,
    difficulty,
    routine_config: routineConfig,
    // Intent recorded at start. Sent unconditionally — the column is nullable,
    // so unlike sampling_version there is no table default to protect.
    planned_duration_ms: plannedDurationMs,
    dpi,
    sens,
    cm_per_360: cmPer360,
    fov_deg: fovDeg,
    refresh_hz: refreshHz,
    device_fingerprint: deviceFingerprint,
    user_agent: userAgent,
    platform,
    screen_width: screenWidth,
    screen_height: screenHeight,
    device_pixel_ratio: devicePixelRatio,
    app_version: appVersion
  };

  // The client-minted session uuid (game.js). Omitted when absent so a caller
  // that does not supply one still gets the table's gen_random_uuid() default.
  if (id !== undefined && id !== null) {
    payload.id = id;
  }

  // sampling_version is NOT NULL with a table default; omit the key when unset
  // so the default applies rather than sending a null that violates it.
  if (samplingVersion !== null && samplingVersion !== undefined) {
    payload.sampling_version = samplingVersion;
  }

  return payload;
}

// Assembles one `segments` row. Fields that do not apply to a segment's outcome
// are passed as null: a `track` window has no click, so time_to_click_ms /
// dwell_ms / click offsets are null; a `timeout` has no landed shot either. The
// schema's check constraint rejects any non-click row that carries them.
// session_id is stamped in supabase.js once the session insert resolves.
export function buildSegmentPayload({
  segmentIndex,
  startedAtMs = null,
  outcome,
  targetDistance = null,
  timeToClickMs = null,
  dwellMs = null,
  clickOffset = null,
  targetCount,
  targets,
  engagedIndex = null,
  frames,
  inputs = [],
  // Whether the engaged target moved during the segment. Drives whether
  // trajectory carries tx/ty/tz (moving) or omits it (static — see toColumnar).
  // `strafing` is a shipping routine that sets this, so do not remove it.
  movesTargets = false
}) {
  // Nullable by design: a session may run without raw capture. Store null rather
  // than an empty stream so "not captured" is distinct from "captured nothing".
  const hasInputs = inputs.length > 0;

  return {
    segment_index: segmentIndex,
    started_at_ms: startedAtMs,
    outcome,
    target_distance: targetDistance,
    time_to_click_ms: timeToClickMs,
    dwell_ms: dwellMs,
    click_offset_x: clickOffset === null ? null : clickOffset.x,
    click_offset_y: clickOffset === null ? null : clickOffset.y,
    target_count: targetCount,
    targets,
    engaged_index: engagedIndex,
    trajectory: toColumnar(frames, movesTargets),
    input_events: hasInputs ? inputsToColumnar(inputs) : null,
    frame_count: frames.length,
    event_count: hasInputs ? inputs.length : null,
    // Segment wall-time: the last frame's t is milliseconds from segment start,
    // which is the duration up to the closing frame. 0 for a one-frame segment.
    duration_ms: frames.length > 0 ? frames[frames.length - 1].t : 0
  };
}
