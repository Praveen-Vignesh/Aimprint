import { ROUTINES, routineById } from '../routines/index.js';
import { DIFFICULTY_LEVELS } from '../difficulty.js';
import { createSensitivity } from '../sensitivity.js';
import { formatClock } from '../hud.js';
import { VERIFY_STATES } from '../verify-client.js';
import {
  SESSION_DURATIONS_MIN,
  SESSION_COMPLETE_FRACTION,
  SESSION_MIN_PLAY_MS
} from '../constants.js';

// Owns the home, pause and results screens: renders the routine catalogue and
// sensitivity settings, writes setting changes straight back into the store, and
// gates Start on the account state.
//
// It does NOT own the sign-in form. That lives in `ui/auth-panel.js` on the
// landing pages, because this page is past the gate — by the time anyone is here
// they have an account. All this needs is the identity row, a notice pointing
// home when the account is not ready, and the Start gate. `auth` therefore
// supplies only `onSignOut`. `onEndRun` finishes a run for good; `onMenu` only
// changes screen.
export function createHome({ settings, auth, onStart, onResume, onEndRun, onMenu }) {
  const homeScreen = document.getElementById('home');
  const pauseScreen = document.getElementById('pause');
  const resultsScreen = document.getElementById('results');
  const pauseTimeLeft = document.getElementById('pause-time-left');
  const modeGrid = document.getElementById('mode-grid');
  const difficultyRow = document.getElementById('difficulty-row');
  const durationRow = document.getElementById('duration-row');
  const dpiInput = document.getElementById('dpi-input');
  const sensInput = document.getElementById('sens-input');
  const edpiReadout = document.getElementById('edpi-readout');
  const cm360Readout = document.getElementById('cm360-readout');

  // Identity only: who is signed in, a way out, and a notice when the account
  // is not in a state that can start a run.
  const signedInBlock = document.getElementById('account-signed-in');
  const accountNotice = document.getElementById('account-notice');
  const signoutButton = document.getElementById('signout-button');
  const accountEmail = document.getElementById('account-email');
  const startButton = document.getElementById('start-button');
  const startNote = document.getElementById('start-note');

  // Results screen.
  const resultRoutine = document.getElementById('result-routine');
  const resultTime = document.getElementById('result-time');
  const resultScore = document.getElementById('result-score');
  const resultAccuracy = document.getElementById('result-accuracy');
  const resultAvgTime = document.getElementById('result-avg-time');
  const resultNote = document.getElementById('result-note');
  const resultVerify = document.getElementById('result-verify');
  const resultVerifyLabel = document.getElementById('result-verify-label');

  const modeButtons = new Map();
  const difficultyButtons = new Map();
  const durationButtons = new Map();

  // Results-screen trust badge copy, keyed by verify-client state. States not
  // listed here (OFF, UNAVAILABLE) hide the badge entirely — a network failure
  // or an unconfigured endpoint stays silent, same as "no Supabase creds → the
  // app still runs". The 'match'/'mismatch' classes drive the label colour.
  const VERIFY_COPY = {
    [VERIFY_STATES.CHECKING]: { text: 'Checking your play style…', cls: '' },
    [VERIFY_STATES.MATCH]: { text: 'Play style matches your history', cls: 'match' },
    [VERIFY_STATES.MISMATCH]: { text: 'Play style differs from your usual', cls: 'mismatch' },
    [VERIFY_STATES.NOT_ENOUGH_HISTORY]: { text: 'Not enough of your history yet to check', cls: '' },
    [VERIFY_STATES.MODEL_NOT_READY]: { text: 'Style check isn’t available yet', cls: '' }
  };

  // Latest input to the Start gate, so a settings-only re-render does not need
  // it threaded through.
  let lastAuthState = { status: 'loading', email: null };

  for (const routine of ROUTINES) {
    const tile = document.createElement('button');
    tile.className = 'mode-tile';
    tile.disabled = routine.available === false;
    tile.innerHTML =
      `<span class="mode-name">${routine.name}</span>` +
      `<span class="mode-blurb">${routine.blurb}</span>` +
      `<span class="mode-tag">${routine.available ? 'Ready' : `Phase ${routine.phase}`}</span>`;
    tile.addEventListener('click', () => settings.update({ routine: routine.id }));
    modeGrid.appendChild(tile);
    modeButtons.set(routine.id, tile);
  }

  for (const level of DIFFICULTY_LEVELS) {
    const button = document.createElement('button');
    button.className = 'segment';
    button.textContent = level;
    button.addEventListener('click', () => settings.update({ difficulty: level }));
    difficultyRow.appendChild(button);
    difficultyButtons.set(level, button);
  }

  for (const minutes of SESSION_DURATIONS_MIN) {
    const button = document.createElement('button');
    button.className = 'segment';
    button.textContent = `${minutes} min`;
    button.addEventListener('click', () => settings.update({ duration: minutes }));
    durationRow.appendChild(button);
    durationButtons.set(minutes, button);
  }

  function renderReadout(dpi, sens) {
    if (Number.isFinite(dpi) === false || Number.isFinite(sens) === false || dpi <= 0 || sens <= 0) {
      edpiReadout.textContent = '—';
      cm360Readout.textContent = '—';
      return;
    }

    const sensitivity = createSensitivity({ dpi, sens });
    edpiReadout.textContent = Math.round(sensitivity.eDPI);
    cm360Readout.textContent = `${sensitivity.cm360.toFixed(1)} cm`;
  }

  // Preview while typing, without committing: clamping a half-typed "8" on its
  // way to "800" would fight the player's keystrokes. Commit lands on change.
  dpiInput.addEventListener('input', () =>
    renderReadout(Number(dpiInput.value), Number(sensInput.value))
  );
  sensInput.addEventListener('input', () =>
    renderReadout(Number(dpiInput.value), Number(sensInput.value))
  );

  const commit = () =>
    settings.update({ dpi: Number(dpiInput.value), sens: Number(sensInput.value) });

  dpiInput.addEventListener('change', commit);
  sensInput.addEventListener('change', commit);

  signoutButton.addEventListener('click', () => auth.onSignOut());

  // Start is gated on being signed in. This mirrors canPlay() in main.js, which
  // guards the click path; both must agree, so neither may grow a condition
  // alone — a gate that passes in one and fails in the other is either an
  // unreachable button or a bypass.
  function applyStartGate() {
    const signedIn = lastAuthState.status === 'signed_in';
    const loading = lastAuthState.status === 'loading';

    startButton.disabled = loading || signedIn === false;

    if (loading) {
      startNote.textContent = 'Checking your session…';
    } else if (signedIn === false) {
      // Briefly visible, if at all: main.js redirects a signed-out visitor to
      // '/' the moment the auth state resolves. This just covers the instant
      // before that navigation lands.
      startNote.textContent = 'Signed out — redirecting…';
    } else {
      startNote.textContent = 'Esc pauses the clock. Left click to shoot.';
    }
  }

  startButton.addEventListener('click', () => {
    if (startButton.disabled) return;
    onStart();
  });
  document.getElementById('resume-button').addEventListener('click', onResume);
  // Ends the run rather than just changing screen: leaving a paused session open
  // would orphan it, and its telemetry would never be flushed.
  document.getElementById('menu-button').addEventListener('click', onEndRun);
  document.getElementById('results-menu-button').addEventListener('click', onMenu);

  return {
    render(state) {
      for (const [id, tile] of modeButtons) {
        tile.classList.toggle('selected', id === state.routine);
      }
      for (const [level, button] of difficultyButtons) {
        button.classList.toggle('selected', level === state.difficulty);
      }
      for (const [minutes, button] of durationButtons) {
        button.classList.toggle('selected', minutes === state.duration);
      }

      dpiInput.value = state.dpi;
      sensInput.value = state.sens;
      renderReadout(state.dpi, state.sens);
    },

    // Re-renders the account panel and the Start gate. Called on every auth
    // change.
    renderAccount({ authState }) {
      lastAuthState = authState;

      const signedIn = authState.status === 'signed_in';

      signedInBlock.classList.toggle('hidden', signedIn === false);

      if (signedIn) accountEmail.textContent = authState.email ?? 'your account';

      // No notice to show: a signed-out visitor is redirected to '/' by
      // main.js before they would ever need to read one. This block only
      // covers the instant before that navigation lands.
      const notice = signedIn === false && authState.status !== 'loading' ? 'Redirecting to sign in…' : '';

      accountNotice.textContent = notice;
      accountNotice.classList.toggle('hidden', notice === '');

      applyStartGate();
    },

    // The pause clock is static: the countdown is frozen while paused, so this
    // is written once on entry rather than ticking.
    renderPause({ remainingMs }) {
      pauseTimeLeft.textContent = formatClock(remainingMs);
    },

    // Worded as progress, never as a saved record. The authoritative completion
    // verdict is derived offline from delivered segments and will legitimately
    // differ — a segment still in the outbox is not yet a delivered row.
    renderResults(summary) {
      if (summary === null) return;

      // Reset the trust badge to hidden on every render; finishRun drives it to
      // 'checking' and then the resolved state only for a saved, signed-in run.
      if (resultVerify) {
        resultVerify.classList.add('hidden');
        resultVerify.classList.remove('match', 'mismatch');
      }

      const { routineId, difficulty, plannedMs, activeMs } = summary;
      const { hits, attempts, clicks, totalTimeMs, completed, saved } = summary;
      const name = routineById(routineId)?.name ?? routineId;
      const timed = clicks === 0 ? attempts : clicks;

      resultRoutine.textContent = `${name} · ${difficulty}`;
      resultTime.textContent = `${formatClock(activeMs)} of ${formatClock(plannedMs)}`;
      resultScore.textContent = hits;
      resultAccuracy.textContent =
        attempts === 0 ? '0%' : `${Math.round((hits / attempts) * 100)}%`;
      resultAvgTime.textContent = timed === 0 ? '0 ms' : `${Math.round(totalTimeMs / timed)} ms`;

      // "Not saved" outranks the completion percentage: a run that recorded
      // nothing is the one fact the player needs, and a discarded run that
      // looked saved is precisely the silent loss this project cannot afford.
      // `saved === false` only, never a falsy test — an older summary without
      // the field must not read as discarded.
      const percent = Math.round(SESSION_COMPLETE_FRACTION * 100);
      if (saved === false) {
        const minimum = Math.round(SESSION_MIN_PLAY_MS / 1000);
        resultNote.textContent =
          `Under ${minimum} seconds, so this run was not saved — nothing was recorded.`;
      } else {
        resultNote.textContent = completed
          ? `Session complete — you passed the ${percent}% mark.`
          : `Under the ${percent}% mark, so this run does not count as complete.`;
      }
    },

    // Drives the post-session trust badge. Called first with 'checking' and
    // then with the resolved verify-client state. OFF/UNAVAILABLE (and any
    // unknown state) hide the badge, keeping an unreachable or unconfigured
    // endpoint silent.
    setVerifyState(state) {
      if (!resultVerify) return;
      const copy = VERIFY_COPY[state];
      resultVerify.classList.remove('match', 'mismatch');
      if (!copy) {
        resultVerify.classList.add('hidden');
        return;
      }
      resultVerifyLabel.textContent = copy.text;
      if (copy.cls) resultVerify.classList.add(copy.cls);
      resultVerify.classList.remove('hidden');
    },

    setScreen(screen) {
      homeScreen.classList.toggle('hidden', screen !== 'home');
      pauseScreen.classList.toggle('hidden', screen !== 'paused');
      resultsScreen.classList.toggle('hidden', screen !== 'results');
    }
  };
}
