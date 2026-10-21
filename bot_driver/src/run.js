// Aimprint bot driver — the harness.
//
// Drives the REAL game in a REAL Chromium through Playwright so the telemetry it
// produces is genuine synthetic reference data, written by the unmodified app
// through its own outbox. Nothing here touches src/ at runtime beyond reading
// the DEV-only window.__aimbot hook (main.js, gated behind import.meta.env.DEV).
//
// Deterministic aiming: each frame it reads the engaged target's world position
// and the camera's current yaw/pitch from window.__aimbot(), computes the
// angular error, asks the chosen variant controller for a turn step, converts
// that step to integer mouse-movement counts using the game's own pointerSpeed,
// and dispatches it through the real movementX/movementY path. No screenshots.
//
// Usage (from bot_driver/, after `npm install` and `npx playwright install
// chromium`, with the dev server running `npm run dev` in the repo root):
//
//   node src/run.js --email bot-linear-1@aimprint-test.local --password <pw> \
//        --routine flick --difficulty medium --duration 3 --variant linear
//
// The account must already exist, be email-confirmed, and be labelled synthetic
// — create it with model/src/bot_detection/provision_bot_subjects.py.

import { chromium } from 'playwright';
import { CONTROLLERS } from './controllers.js';

const CONTROLS_RADIANS_PER_UNIT = 0.002; // three PointerLockControls internal
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function wrapAngle(a) {
  // Fold into [-pi, pi] so a yaw error never takes the long way round.
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Small seedable PRNG (mulberry32) so a variant's jitter is reproducible per run.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function signIn(page, url, email, password) {
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.click('[data-modal="open"]');
  await page.fill('[data-auth="email"]', email);
  await page.fill('[data-auth="password"]', password);
  await page.click('[data-auth="signin"]');
  await page.waitForFunction(() => {
    for (let i = 0; i < localStorage.length; i++) {
      if ((localStorage.key(i) || '').includes('auth-token')) return true;
    }
    return false;
  }, { timeout: 15000 });
  // landing.js redirects to /play on a successful sign-in (window.location.href).
  // Wait for that natural navigation rather than racing it with our own goto;
  // only force it if the redirect somehow does not fire.
  await page.waitForURL('**/play', { timeout: 15000 })
    .catch(() => page.goto(`${url}/play`, { waitUntil: 'domcontentloaded' }));
}

export async function runBot({
  url = 'http://localhost:5173',
  email,
  password,
  routine = 'flick',
  difficulty = 'medium',
  durationMin = 3,
  variant = 'linear',
  headless = false,
  seed = 1
}) {
  const controller = CONTROLLERS[variant];
  if (!controller) {
    throw new Error(`Unknown variant ${variant}. Available: ${Object.keys(CONTROLLERS).join(', ')}`);
  }
  const rng = makeRng(seed);
  const tag = `[${variant}:${email}]`;

  // Anti-throttling flags are load-bearing for the fleet: Chromium throttles
  // requestAnimationFrame (and timers) in unfocused/occluded windows, so with
  // several headed windows open in parallel all but the focused one nearly
  // freeze — the game loop stops advancing, dispatched turns aren't processed,
  // and the aim "fails to converge". These keep every window running full-speed.
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    // Seed the game's settings BEFORE /play loads (key + shape load-bearing,
    // settings.js). duration is in MINUTES; 3 is now an allowed value.
    await context.addInitScript(
      ([r, d, dur]) => {
        try {
          localStorage.setItem('aim-trainer.settings', JSON.stringify({
            routine: r, difficulty: d, duration: dur, dpi: 800, sens: 0.4
          }));
        } catch (_) { /* private mode — home.js falls back to defaults */ }
      },
      [routine, difficulty, durationMin]
    );

    const page = await context.newPage();
    await signIn(page, url, email, password);

    await page.waitForSelector('#start-button', { timeout: 15000 });
    await page.waitForFunction(
      () => !document.querySelector('#start-button')?.disabled,
      { timeout: 15000 }
    );

    // The hook must be present — if it is not, we are pointed at a production
    // build, not the dev server, and must not pretend to produce data.
    const hasHook = await page.evaluate(() => typeof window.__aimbot === 'function');
    if (!hasHook) {
      throw new Error('window.__aimbot missing — run against `npm run dev`, not a prod build');
    }

    const cdp = await context.newCDPSession(page);
    // Chromium derives movementX/movementY under pointer lock from the CHANGE in
    // the dispatched x,y position — the movementX/movementY event fields are
    // ignored for synthetic events. So we track a virtual cursor and dispatch
    // cumulative absolute positions; the per-frame delta IS the turn. (Verified
    // empirically — passing movementX/Y fields, as the old driver did, moved the
    // camera almost not at all.)
    //
    // The virtual cursor maps 1:1 to absolute camera yaw/pitch (vx = ORIGIN −
    // yaw/k), and camera yaw/pitch are bounded (targets span a limited angle), so
    // vx/vy stay within ORIGIN ± ~1500. We start at a large ORIGIN so that range
    // never approaches 0 — Chromium clamps synthetic x,y at 0, and a target far
    // to one side was driving the cumulative position negative and freezing the
    // aim (caught by the convergence guard, but fatal to the run).
    const ORIGIN = 5000;
    let vx = ORIGIN, vy = ORIGIN;

    await page.click('#start-button');
    await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 10000 });
    console.log(`${tag} lock acquired, running ${routine}/${difficulty} ${durationMin}min`);

    let shots = 0;
    let lastFire = 0;
    let onTargetSince = 0;
    let state = {};
    let lastTargetKey = null;

    // Convergence self-check. Two distinct failure modes, told apart by whether
    // the camera angles actually MOVE in response to a dispatched turn:
    //   * angles move but the error does not shrink  → a genuine sign/aim error.
    //   * angles do not move at all despite dispatches → the window is stalled
    //     (unfocused/occluded/throttled, or pointer lock is a no-op).
    // Either way we abort rather than write junk, but the stall path is given a
    // much longer fuse so a transient startup hiccup does not kill a good run.
    let framesOnTarget = 0;
    let bestErrForTarget = Infinity;
    let badMoves = 0;    // dispatched + angles moved + no progress (sign error)
    let stallMoves = 0;  // dispatched but angles frozen (stalled window)
    let prevYaw = null, prevPitch = null;

    const startAt = Date.now();
    const endAt = startAt + durationMin * 60 * 1000;
    let nextBeat = startAt + 30000;

    while (Date.now() < endAt) {
      if (Date.now() >= nextBeat) {
        console.log(`${tag} ${Math.round((Date.now() - startAt) / 1000)}s — ${shots} shots`);
        nextBeat += 30000;
      }
      const locked = await page.evaluate(() => document.pointerLockElement !== null);
      if (!locked) { console.log(`${tag} lock released (run ended)`); break; }

      const st = await page.evaluate(() => window.__aimbot());
      if (!st || !st.target) { await sleep(16); continue; }

      const { x, y, z, r } = st.target;
      // Camera sits at the origin looking down -Z, so the target world position
      // IS the direction to it. Convert to the same yaw/pitch convention
      // cameraAngles() reports (YXZ euler).
      const h = Math.hypot(x, z);
      const desiredYaw = Math.atan2(-x, -z);
      const desiredPitch = Math.atan2(y, h);
      const err = {
        yaw: wrapAngle(desiredYaw - st.yaw),
        pitch: desiredPitch - st.pitch
      };

      // New target (respawned after a hit, or first acquire) → reset variant
      // state and the convergence tracker.
      const targetKey = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      if (targetKey !== lastTargetKey) {
        lastTargetKey = targetKey;
        state = {};
        onTargetSince = 0;
        framesOnTarget = 0;
        bestErrForTarget = Infinity;
        // Random arc side for the bezier variant, so curves are not all one way.
        state.side = rng() < 0.5 ? -1 : 1;
      }

      const errMag = Math.hypot(err.yaw, err.pitch);
      const madeProgress = errMag < bestErrForTarget - 1e-4;
      if (madeProgress) { bestErrForTarget = errMag; badMoves = 0; stallMoves = 0; }

      const step = controller.aim(err, state, rng);
      const k = CONTROLS_RADIANS_PER_UNIT * st.pointerSpeed;
      const mx = Math.round(-step.dYaw / k);
      const my = Math.round(-step.dPitch / k);

      if (mx !== 0 || my !== 0) {
        vx += mx; vy += my;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: vx, y: vy, buttons: 0
        });
        // Did the camera actually respond to the last dispatch?
        const angleMoved = prevYaw === null ||
          Math.abs(st.yaw - prevYaw) + Math.abs(st.pitch - prevPitch) > 1e-5;
        if (!madeProgress) {
          if (angleMoved) badMoves++; else stallMoves++;
        }
        // Angles move but the running-best error won't improve for a long stretch
        // → genuinely orbiting/diverging. The threshold is deliberately high
        // (~4s at 60Hz) because the overshoot and bezier variants are NON-
        // monotonic by design — they intentionally swing past or arc away from
        // the target before settling, so a short no-new-best window is normal and
        // must not be mistaken for a broken aim.
        if (badMoves > 250 && bestErrForTarget > 0.02) {
          throw new Error(
            `${tag} aim not converging (err stuck at ${bestErrForTarget.toFixed(3)} rad, ` +
            `angles moving) — sign/aim error. Aborting, no junk written.`
          );
        }
        // Angles frozen through ~13s of dispatches → window stalled / lock no-op.
        if (stallMoves > 800) {
          throw new Error(
            `${tag} camera frozen through ${stallMoves} dispatched turns — stalled or ` +
            `occluded window / pointer-lock no-op. Aborting, no junk written.`
          );
        }
      }
      prevYaw = st.yaw; prevPitch = st.pitch;

      // Fire when the GAME says the crosshair is on the target, after this
      // variant's reaction delay, rate-limited so one hit is one click.
      if (st.onTarget) {
        if (onTargetSince === 0) onTargetSince = Date.now();
        framesOnTarget++;
        const settled = Date.now() - onTargetSince >= controller.reactionMs;
        if (settled && Date.now() - lastFire > 90) {
          // Click at the CURRENT virtual position so the press injects no
          // spurious movement delta (a differing x,y would read as a turn).
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vx, y: vy, button: 'left', buttons: 1, clickCount: 1 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vx, y: vy, button: 'left', buttons: 0, clickCount: 1 });
          lastFire = Date.now();
          shots++;
        }
      } else {
        onTargetSince = 0;
      }

      await sleep(16); // ~60 Hz
    }

    console.log(`${tag} done — fired ${shots} shots. Flushing outbox...`);
    // Must pass SESSION_MIN_PLAY_MS (60s); 3 min clears it. Let the IndexedDB
    // outbox deliver before the context closes.
    await sleep(6000);
    return { shots, email, variant };
  } finally {
    await browser.close();
  }
}

// Standalone CLI (single bot). The fleet runner (fleet.js) imports runBot directly.
const isMain = import.meta.url === `file://${process.argv[1]}` ||
               import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isMain) {
  const email = arg('email');
  const password = arg('password');
  if (!email || !password) {
    console.error('Required: --email and --password (from provision_bot_subjects.py)');
    process.exit(1);
  }
  runBot({
    url: arg('url', 'http://localhost:5173'),
    email,
    password,
    routine: arg('routine', 'flick'),
    difficulty: arg('difficulty', 'medium'),
    durationMin: Number(arg('duration', '3')),
    variant: arg('variant', 'linear'),
    headless: arg('headless', 'false') === 'true',
    seed: Number(arg('seed', '1'))
  }).catch((err) => { console.error(err.message || err); process.exit(1); });
}
