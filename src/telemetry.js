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
// from the per-frame trajectory. sampling_version 1 stores each timestamp as an
// INTEGER number of tenths of a millisecond (0.1 ms resolution): fine enough to
// keep ~1 ms poll gaps distinct, but an integer, which is what lets the stream
// be delta-encoded losslessly (see inputsToColumnar — integer cumsum is exact,
// a float cumsum over hundreds of terms would drift). Whole-ms rounding, which
// trajectory `t` still uses, would collapse adjacent 1 ms samples.
const INPUT_TIME_PRECISION = 1e1;

// poll_hz measurement. Pointer inter-arrival gaps are bucketed into a fixed
// histogram indexed by the gap itself, in the same integer tenths of a
// millisecond recordInput already rounds to — so bucket 10 is a 1 ms gap
// (1000 Hz). 2000 buckets covers 0–200 ms, which is far beyond any real
// polling rate, and costs one small Int32Array per session.
//
// A histogram rather than a running mean, because the statistic has to be the
// MEDIAN: a backgrounded tab, an alt-tab or a GC pause produces a single
// enormous gap, and one such outlier drags a mean down by hundreds of Hz. The
// median is immune to a handful of them and a histogram makes it exact without
// retaining the hundreds of thousands of individual samples a session produces.
const POLL_HIST_LEN = 2000;
// Below this many measured gaps the median is not worth reporting, and poll_hz
// is left null for the offline backfill (queries/campaign.sql section 5b) to
// fill in from the stored stream.
const POLL_MIN_SAMPLES = 100;

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

  // poll_hz state, SESSION-scoped — createTelemetry() is constructed once per
  // game, so these are reset by beginSession(), never by beginSegment().
  let pollHist = null;
  let pollSamples = 0;
  // The previous sample's `t`, or null when the next sample must not be
  // differenced against anything. Cleared on every segment boundary: `t` is
  // relative to segmentStart, so a gap taken across a boundary would be the
  // difference between two unrelated origins — a large negative number, or
  // worse, a plausible-looking small one.
  let lastInputT = null;

  return {
    // Opens a fresh session. Resets the poll histogram, which spans the whole
    // run rather than one segment: a per-segment median would be computed from
    // a second of samples and the run's figure would then be a median of
    // medians, which is not the median.
    beginSession() {
      pollHist = new Int32Array(POLL_HIST_LEN);
      pollSamples = 0;
      lastInputT = null;
    },

    // The measured pointer polling rate for the session so far, or null when
    // too few gaps were seen to mean anything. Walks the cumulative counts to
    // the bucket holding the median gap and converts: a gap of `g` tenths of a
    // millisecond is 10000 / g Hz (10 tenths = 1 ms = 1000 Hz).
    pollHz() {
      if (pollHist === null || pollSamples < POLL_MIN_SAMPLES) return null;

      const middle = pollSamples / 2;
      let seen = 0;
      for (let gap = 0; gap < POLL_HIST_LEN; gap++) {
        seen += pollHist[gap];
        if (seen < middle) continue;
        // A zero gap means two samples rounded into the same tenth of a
        // millisecond, which carries no rate information and would divide by
        // zero. Treat it as unmeasurable rather than reporting Infinity.
        return gap === 0 ? null : Math.round((10000 / gap) * 10) / 10;
      }
      return null;
    },

    // Opens a fresh segment. New arrays are allocated rather than emptied in
    // place, because the previous segment's arrays may still be on their way to
    // Supabase. `boardSnapshot` is the layout of every live target at the start
    // of the segment: [{x, y, z, r}].
    beginSegment(timestamp, boardSnapshot) {
      segmentStart = timestamp;
      frames = [];
      inputs = [];
      board = boardSnapshot;
      // See lastInputT above: `t` is segment-relative, so the first sample of a
      // new segment has nothing valid to be differenced against.
      lastInputT = null;
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
      const t = Math.round((eventTime - segmentStart) * INPUT_TIME_PRECISION);

      inputs.push({ t, dx, dy });

      // Bucket the inter-arrival gap for poll_hz. Out-of-range gaps (a tab that
      // was backgrounded for a minute) are dropped rather than clamped into the
      // top bucket, which would pull the median toward a rate nobody has.
      if (pollHist !== null && lastInputT !== null) {
        const gap = t - lastInputT;
        if (gap >= 0 && gap < POLL_HIST_LEN) {
          pollHist[gap]++;
          pollSamples++;
        }
      }
      lastInputT = t;
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
// `movesTargets` (sampling_version 1): when false, the engaged target is static
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

// Columnar + DELTA-encoded raw input stream (sampling_version 1): {t0, dt, dx,
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
// ended_at and poll_hz are DELIBERATELY NOT in this payload, even though the
// client now writes both. They are written at CLOSE time, by closeSession() in
// supabase.js, through a separate one-shot UPDATE policy — and the column-level
// INSERT grant in schema.sql excludes them, so naming either here (even as
// null) makes PostgREST reject the whole insert with 42501, which the outbox
// classifies as permanent and DROPS. Every session would silently vanish.
// started_at is excluded for the same mechanical reason and is server-stamped.
// Do not add any of the three back here.
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
