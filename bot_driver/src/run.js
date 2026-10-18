// Aimprint bot driver — the harness.
//
// Drives the REAL game in a REAL (headed) Chromium through Playwright so the
// telemetry it produces is genuine synthetic reference data, written by the
// unmodified app through its own outbox. Nothing here touches src/.
//
// Usage (from bot_driver/, after `npm install` and `npx playwright install
// chromium`, with the dev server running `npm run dev` in the repo root):
//
//   node src/run.js --email bot01@example.com --password <pw> \
//        --routine flick --difficulty medium --duration 5 --variant snap
//
// The account must already exist, be email-confirmed, and be labelled
// synthetic — create it with model/src/provision_bot_subjects.py, which prints
// the password to pass here.
//
// VERIFY IN THE HEADED WINDOW FIRST (plan): watch that the camera actually
// swings onto targets and clicks land. Pointer-lock-under-automation can
// silently no-op (lock granted but movementX/Y never arriving); the auto-flip
// below handles a wrong sign, but a total no-op needs a human to notice.

import { chromium } from 'playwright';
import { findTarget } from './vision.js';
import { CONTROLLERS, DEFAULT_SIGN } from './controllers.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const URL = arg('url', 'http://localhost:5173');
const EMAIL = arg('email');
const PASSWORD = arg('password');
const ROUTINE = arg('routine', 'flick');
const DIFFICULTY = arg('difficulty', 'medium');
const DURATION_MIN = Number(arg('duration', '5'));
const VARIANT = arg('variant', 'snap');

if (!EMAIL || !PASSWORD) {
  console.error('Required: --email and --password (from provision_bot_subjects.py)');
  process.exit(1);
}
const controller = CONTROLLERS[VARIANT];
if (!controller) {
  console.error(`Unknown --variant ${VARIANT}. Available: ${Object.keys(CONTROLLERS).join(', ')}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(page) {
  await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
  // Open the auth modal, fill it, submit. Selectors from the Explore trace of
  // index.html / auth-panel.js.
  await page.click('[data-modal="open"]');
  await page.fill('[data-auth="email"]', EMAIL);
  await page.fill('[data-auth="password"]', PASSWORD);
  await page.click('[data-auth="signin"]');

  // Wait for the supabase session to land in localStorage (robust against UI
  // timing — the token key contains "auth-token").
  await page.waitForFunction(() => {
    for (let i = 0; i < localStorage.length; i++) {
      if ((localStorage.key(i) || '').includes('auth-token')) return true;
    }
    return false;
  }, { timeout: 15000 });
  console.log('Signed in.');
}

async function run() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  // Seed the game's settings BEFORE /play loads, so home.js reads the routine/
  // difficulty/duration we want without us having to click the right tiles.
  // Key and shape are load-bearing (settings.js): 'aim-trainer.settings'.
  await context.addInitScript(
    ([routine, difficulty, duration]) => {
      try {
        localStorage.setItem('aim-trainer.settings', JSON.stringify({
          routine, difficulty, duration, dpi: 800, sens: 0.4
        }));
      } catch (_) { /* private mode etc. — home.js will fall back to defaults */ }
    },
    [ROUTINE, DIFFICULTY, DURATION_MIN]
  );

  const page = await context.newPage();
  await signIn(page);

  await page.goto(`${URL}/play`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#start-button', { timeout: 15000 });
  // The gate is signed_in only; give main.js's validateSession() a beat to
  // confirm the restored session before the button enables.
  await page.waitForFunction(
    () => !document.querySelector('#start-button')?.disabled,
    { timeout: 15000 }
  );

  const cdp = await context.newCDPSession(page);
  const canvas = page.locator('canvas').first();
  const cx = 640;
  const cy = 360; // viewport centre; ignored under lock but required by CDP

  // Trusted user gesture -> requestPointerLock (runs synchronously in the
  // click handler, see controls.js). Playwright's click is trusted.
  await page.click('#start-button');
  await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 10000 });
  console.log(`Pointer lock acquired. Running ${VARIANT} on ${ROUTINE}/${DIFFICULTY} for ${DURATION_MIN} min.`);

  let sign = DEFAULT_SIGN;
  let prevErr = Infinity;
  let growing = 0;
  let lastFire = 0;
  let shots = 0;
  const endAt = Date.now() + DURATION_MIN * 60 * 1000;

  while (Date.now() < endAt) {
    // The game ends itself at the planned duration and releases the lock.
    const locked = await page.evaluate(() => document.pointerLockElement !== null);
    if (!locked) {
      console.log('Pointer lock released (run ended).');
      break;
    }

    let shot;
    try {
      shot = await canvas.screenshot();
    } catch (_) {
      await sleep(30);
      continue;
    }
    const target = findTarget(shot);

    if (target) {
      const err = Math.hypot(target.dx, target.dy);
      // Auto-flip the sign if the error keeps growing — self-corrects a wrong
      // initial mapping in the headed window instead of diverging.
      if (err > prevErr - 0.5) growing++; else growing = 0;
      if (growing >= 3) { sign = -sign; growing = 0; console.log(`Flipped aim sign -> ${sign}`); }
      prevErr = err;

      const { mx, my, fire } = controller(target, sign);
      if (mx !== 0 || my !== 0) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: cx, y: cy, movementX: mx, movementY: my, buttons: 0
        });
      }
      // Rate-limit fire so one hit is one click, not a burst.
      if (fire && Date.now() - lastFire > 120) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
        lastFire = Date.now();
        shots++;
        prevErr = Infinity; // target will respawn elsewhere; reset tracking
      }
    }

    await sleep(25); // let a frame render; keeps the loop ~30-40 Hz
  }

  console.log(`Done. Fired ${shots} shots. Letting the outbox flush...`);
  // The session must pass SESSION_MIN_PLAY_MS (60s) to be saved at all; a run
  // this short on purpose would write nothing. Give the IndexedDB outbox time
  // to deliver before the context closes.
  await sleep(6000);
  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
