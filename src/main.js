import './style.css';
import { createScene } from './scene.js';
import { createControls, applySensitivity, requestLock } from './controls.js';
import { createGame } from './game.js';
import { createHud } from './hud.js';
import { createSettings } from './settings.js';
import { createSensitivity } from './sensitivity.js';
import { configFor } from './difficulty.js';
import { routineById } from './routines/index.js';
import { createHome } from './ui/home.js';
import {
  getAuthState,
  onAuthChange,
  signOut,
  validateSession,
  initTelemetryOutbox,
  flushTelemetry,
  flushTelemetryKeepalive,
  getSubjectId
} from './supabase.js';
import { verifySession, warmVerifyService, VERIFY_STATES } from './verify-client.js';
import {
  MOUSE_COUNT_SCALE,
  CAMERA_FOV,
  APP_VERSION,
  SAMPLING_VERSION,
  MS_PER_MINUTE,
  BACKGROUND_COLOR,
  TARGET_COLOR
} from './constants.js';

// Two colours exist in both worlds: Three needs numbers, CSS needs strings, and
// they must match or the panel background disagrees with the scene behind it.
// Publishing constants.js into the token layer makes it the single source —
// style.css carries the same literals only as a pre-JS fallback, so the running
// app cannot drift even if those fall out of sync.
function publishColorTokens() {
  const hex = (value) => `#${value.toString(16).padStart(6, '0')}`;
  const root = document.documentElement.style;
  root.setProperty('--color-bg', hex(BACKGROUND_COLOR));
  root.setProperty('--color-accent', hex(TARGET_COLOR));
}

publishColorTokens();

const crosshair = document.getElementById('crosshair');

const { scene, camera, renderer, resize } = createScene(document.getElementById('scene'));
const settings = createSettings();

let sensitivity = createSensitivity({ ...settings.get(), countScale: MOUSE_COUNT_SCALE });

const controls = createControls(camera, document.body, sensitivity);
const hud = createHud();

const game = createGame({ scene, camera, crosshair, hud, onExpire: () => finishRun() });

// idle | running | paused. Pointer lock is no longer the session boundary, so
// the lock/unlock events alone cannot say whether a lock starts a run or resumes
// one — and an unlock we caused ourselves must not reopen the pause screen.
let runState = 'idle';

// Ends the run for good: freezes the summary, ships what is buffered, drops the
// pointer lock and shows the results. runState is cleared BEFORE unlocking,
// because exitPointerLock() fires its `unlock` event in a later task and that
// handler would otherwise replace the results screen with the pause screen.
function finishRun() {
  if (runState === 'idle') return;

  runState = 'idle';

  // A sens/dpi change queued while this run was live (see settings.subscribe
  // above) is safe to apply now: the run that just ended already has its
  // hardware snapshot baked into its session row, and nothing downstream
  // re-reads live sensitivity state for it.
  if (pendingSettings !== null) {
    const state = pendingSettings;
    pendingSettings = null;
    sensitivity = createSensitivity({ ...state, countScale: MOUSE_COUNT_SCALE });
    applySensitivity(controls, sensitivity);
    home.render(state);
  }

  const summary = game.end();
  flushTelemetry();
  controls.unlock();
  home.renderResults(summary);
  home.setScreen('results');

  // Post-session behavioural-biometric verification: a SECONDARY, decorative
  // signal, never a gate (canPlay() is untouched). Fired non-blocking after the
  // results are already on screen — the badge fills in when the call resolves,
  // and the render loop is never awaited on it.
  maybeVerifySession(summary);
}

// Sends the finished session's segments to the deployed /verify endpoint and
// drives the results-screen trust badge. No-op unless the run was actually saved
// and the player is signed in; stays silent on any failure (verify-client maps
// network/unconfigured to a hidden badge).
function maybeVerifySession(summary) {
  if (summary === null || summary.saved !== true || canPlay() === false) return;
  const segments = summary.segments ?? [];
  if (segments.length === 0) return;

  home.setVerifyState(VERIFY_STATES.CHECKING);
  (async () => {
    const subjectId = await getSubjectId();
    if (subjectId === null) {
      home.setVerifyState(VERIFY_STATES.OFF);
      return;
    }
    const state = await verifySession({ subjectId, segments });
    home.setVerifyState(state);
  })();
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
// Playing requires a real account, with no free-run allowance. The trial that
// used to sit here wrote nothing (no auth session, no subject to attach to), so
// every run it granted was play this project could not learn from — roughly
// twenty minutes discarded per recruited participant. Since the data is the
// deliverable, capturing the first session matters more than the conversion a
// try-before-signup hook would buy.

// The gate is a signed-in account and nothing more. The consent system that
// used to form the second half of it — a version column read back from
// profiles, published on the auth state as `consented` — was removed on
// 2026-10-18; agreement is now part of creating an account and is stated on the
// sign-up card. See schema.sql's profiles comment.

let authState = getAuthState();

function canPlay() {
  return authState.status === 'signed_in';
}

function gatedLock() {
  if (canPlay() === false) {
    home.renderAccount({ authState });
    return;
  }
  requestLock(controls);
}

const home = createHome({
  settings,
  // Sign-in and sign-up are not reachable from this page — they live on the
  // landing page, where the form is. All this screen can do is let someone out
  // of the account they arrived with.
  auth: {
    onSignOut() {
      return signOut();
    }
  },
  onStart: gatedLock,
  onResume: gatedLock,
  onEndRun: finishRun,
  onMenu: () => home.setScreen('home')
});

onAuthChange((state) => {
  authState = state;
  home.renderAccount({ authState });

  // This page is past the gate — there is no sign-in form here, so a
  // signed-out visitor has nothing to do but leave. Bounce them straight to
  // the landing page rather than stranding them on a disabled Start button;
  // 'loading' is excluded, since that is the session still restoring from
  // localStorage, not a verdict.
  if (state.status === 'signed_out') {
    window.location.href = '/';
  }
});

// One sensitivity value, two consumers historically; now just the player. Kept
// as a live update so a settings change applies without a reload.
//
// FROZEN for the duration of a run (running or paused). sessions.dpi/sens/
// cm_per_360 is a single snapshot taken once at game.start() (sessionInfo())
// and never re-read — there is no update grant on those columns, and nothing
// re-stamps them. If a sens change applied live mid-run, the yaw/pitch frames
// recorded after it would be generated under a different dpi/sens mapping than
// the one the session row claims for the whole run, with nothing in the data
// to flag the drift. The home screen's own dpi/sens inputs are unreachable
// during a run anyway (they live on #home, hidden by setScreen('paused')); this
// is what closes the only other path — a dev-tools call to settings.update().
let pendingSettings = null;

settings.subscribe((state) => {
  if (runState === 'running' || runState === 'paused') {
    // Queued, not dropped: applied in finishRun() once the run that was live
    // when it arrived can no longer be affected.
    pendingSettings = state;
    return;
  }
  sensitivity = createSensitivity({ ...state, countScale: MOUSE_COUNT_SCALE });
  applySensitivity(controls, sensitivity);
  home.render(state);
});

home.render(settings.get());
home.renderAccount({ authState });
home.setScreen('home');

// supabase-js trusts the session it restores from localStorage without asking the
// server, so a deleted or revoked account would otherwise render as signed in
// while recording nothing. This is the round-trip that corrects it; the sign-out
// it may trigger flows back through onAuthChange above and re-renders the panel.
//
// The outbox replay is chained AFTER validation settles, not fired alongside it:
// if validation signs out a stale account, the replayed rows are owner-scoped to
// that account and are correctly held rather than thrown at the database under a
// signed-out identity. .finally so replay still runs if validation errors.
validateSession().finally(() => {
  // Replay any telemetry a previous page load could not deliver.
  initTelemetryOutbox();
});

// Rolling refresh-rate estimate, sampled off the render loop (which runs on the
// home screen too), so a run already has a value the moment it starts. The
// sessions row stores it because per-frame cadence scales with refresh_hz.
let lastFrameTs = 0;
let fpsEstimate = 0;

function sampleRefreshHz(now) {
  if (lastFrameTs !== 0) {
    const dt = now - lastFrameTs;
    if (dt > 0) {
      const instant = 1000 / dt;
      fpsEstimate = fpsEstimate === 0 ? instant : fpsEstimate * 0.9 + instant * 0.1;
    }
  }
  lastFrameTs = now;
}

// Coarse, stable, non-identifying: enough to hold out a device, not enough to
// track one. Mirrors the intent of sessions.device_fingerprint in schema.sql.
function deviceFingerprint() {
  const raw = [
    navigator.platform,
    `${screen.width}x${screen.height}`,
    window.devicePixelRatio,
    navigator.hardwareConcurrency
  ].join('|');

  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  return `fp_${(hash >>> 0).toString(16)}`;
}

// The session-scoped hardware block. cm360 is the DPI-independent ground truth;
// dpi/sens are stored raw because dx/dy are meaningless across users without them.
// app_version/sampling_version stamp the code that produced the row.
function sessionInfo() {
  return {
    dpi: sensitivity.dpi,
    sens: sensitivity.sens,
    cmPer360: sensitivity.cm360,
    fovDeg: CAMERA_FOV,
    refreshHz: fpsEstimate > 0 ? Math.round(fpsEstimate) : null,
    // poll_hz is not sent — it is service-written (derived offline) and the
    // schema's column grant excludes it; see buildSessionPayload.
    deviceFingerprint: deviceFingerprint(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    appVersion: APP_VERSION,
    samplingVersion: SAMPLING_VERSION
  };
}

controls.addEventListener('lock', () => {
  // Re-locking mid-run resumes it. The run keeps its session row, its segment
  // ordering and its clock; only the pause offset moves.
  if (runState === 'paused') {
    runState = 'running';
    game.resume();
    home.setScreen('playing');
    return;
  }
  if (runState === 'running') return;

  const { routine, difficulty, duration } = settings.get();

  runState = 'running';
  home.setScreen('playing');
  hud.setMode(`${routineById(routine).name} · ${difficulty} · ${duration} min`);
  game.start({
    routineId: routine,
    difficulty,
    config: configFor(routine, difficulty),
    session: sessionInfo(),
    plannedDurationMs: duration * MS_PER_MINUTE
  });

  // Wake the (free-tier, idle-spun-down) verify service now, at run start, so it
  // is warm by the time the post-session verify call fires minutes from now.
  // Fire-and-forget; no-op when VITE_VERIFY_URL is unset.
  warmVerifyService();
});

controls.addEventListener('unlock', () => {
  // Our own unlock from finishRun() lands here too, after runState is already
  // idle — ignoring it is what keeps the results screen up.
  if (runState !== 'running') return;

  runState = 'paused';
  game.pause();
  // Push whatever the session buffered promptly, rather than waiting for the
  // debounce or the next page load.
  flushTelemetry();
  home.renderPause({ remainingMs: game.remainingMs() });
  home.setScreen('paused');
});

// A closing or backgrounded tab gets one last best-effort delivery; anything it
// cannot send stays in IndexedDB for the next load to replay.
window.addEventListener('pagehide', flushTelemetryKeepalive);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushTelemetryKeepalive();
});

window.addEventListener('resize', resize);

function frame(now) {
  requestAnimationFrame(frame);
  sampleRefreshHz(now);
  game.update(now);
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
