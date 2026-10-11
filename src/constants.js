// Tunable numbers. Everything the scene and the game read lives here.

// Renderer
export const BACKGROUND_COLOR = 0x1a1a1a;
export const MAX_PIXEL_RATIO = 2;

// Camera
export const CAMERA_FOV = 90;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 1000;

// Environment wireframes (depth cues only — nothing is collidable)
export const FLOOR_Y = -5;
export const GRID_SIZE = 60;
export const GRID_DIVISIONS = 30;
export const GRID_COLOR = 0x2f2f2f;
export const GRID_CENTER_COLOR = 0x3d3d3d;

export const WALL_COLOR = 0x2a2a2a;
export const BACK_WALL_Z = -35;
export const SIDE_WALL_X = 20;
export const WALL_HEIGHT = 24;
export const WALL_WIDTH = 40;
export const WALL_DEPTH = 60;
export const WALL_CELL_SIZE = 2;

// Mouse input. Sensitivity is expressed on the Valorant scale and turned into a
// camera rotation rate by sensitivity.js. No smoothing or acceleration is ever
// applied. These are starting values — the home screen overrides and persists.
export const DEFAULT_DPI = 800;
export const DEFAULT_SENSITIVITY = 0.4;
export const PITCH_LIMIT_DEG = 89;

// Counts per unit of reported movementX/Y. Leave at 1 unless a measured 360 on
// the mousepad disagrees with the cm/360 shown on the settings panel.
export const MOUSE_COUNT_SCALE = 1;

// Session defaults, overridden by the home screen.
export const DEFAULT_DIFFICULTY = 'medium';
export const DEFAULT_ROUTINE = 'flick';

// Targets. Radius is a fallback: the active difficulty supplies the real one.
export const TARGET_RADIUS = 0.5;
export const TARGET_COLOR = 0xff5555;
export const TARGET_SEGMENTS = 24;

// A 3D volume, not a wall: z varies so target distance genuinely differs
// between attempts. Radius never scales with distance.
export const SPAWN_VOLUME = { xMin: -8, xMax: 8, yMin: -4, yMax: 4, zMin: -25, zMax: -8 };
export const MIN_SPAWN_DISTANCE = 5;

// Crosshair hit/miss flash duration
export const FEEDBACK_FLASH_MS = 90;

// Tracking routines have no click to end an attempt, so their telemetry is cut
// into fixed windows of this length: one row per window, memory bounded.
export const TRACK_WINDOW_MS = 1000;

// Provenance stamped on every session row. app_version is injected at build
// time from package.json (see vite.config.js); without it a change to the
// sampler or difficulty.js silently mixes incomparable rows into one training
// set. sampling_version tracks the shape AND the clock meaning that
// sampleFrame() produces, and must be bumped whenever either changes — it
// mirrors sessions.sampling_version.
//
// 3: timed sessions. The frame clock excludes paused time, so a segment's `t`
//    and its started_at_ms are active-play milliseconds, not wall clock.
// 4: storage-shrink encoding. input_events is delta-encoded as {t0, dt, dx, dy}
//    with t0/dt in integer TENTHS of a millisecond (0.1 ms resolution, below the
//    ~1 ms poll floor), and the per-frame tx/ty/tz columns are OMITTED for
//    static-target routines (flick, spidershot) — the engaged target is
//    stationary within a segment, so its position already lives in `targets`.
//    Both are lossless in signal; both change the stored SHAPE, so the version
//    moves and any v3 row is excluded from a v4 training pull rather than
//    silently decoded wrong. Decoding lives only in the offline archive job.
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const SAMPLING_VERSION = 4;

// Fixed-duration sessions. The player picks one of these on the home screen and
// it is stamped on the session row as planned_duration_ms — INTENT recorded at
// start, because the client can only write `sessions` at insert time (there is
// no update policy). Whether the run was actually completed is derived offline.
// The 1-minute option was dropped: it is too short to be a useful observation
// and only adds a nuisance covariate. The default is 5 (not 10) because the
// binding constraint is sessions-per-subject across separate days, and a 5-min
// run is one a contributor will actually repeat; a 10-min run is where they
// quietly drop out. planned_duration_ms is on the session row, so a mixed set of
// lengths stays filterable offline regardless.
export const SESSION_DURATIONS_MIN = [5, 10, 15];
export const DEFAULT_SESSION_DURATION_MIN = 5;
export const MS_PER_MINUTE = 60000;

// A run reaching this fraction of its planned duration counts as completed.
// MIRRORED by the offline derivation: change one without the other and the
// number the player sees disagrees with the number the pipeline records.
export const SESSION_COMPLETE_FRACTION = 0.7;

// The consent text version a signup agrees to, stamped on the profile (and
// copied to the subject offline so it survives account deletion). Bump when the
// wording materially changes so old consent is not silently treated as new.
export const CONSENT_VERSION = 'v1-2026-09';
