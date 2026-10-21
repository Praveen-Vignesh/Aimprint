// Fleet runner — drives the whole synthetic-bot cohort in one command.
//
// 5 variants × 3 accounts = 15 synthetic subjects, each playing one 3-minute
// flick session, run in parallel waves to keep wall-clock down. The accounts
// must already be provisioned + labelled synthetic (one cohort per variant) by
// model/src/bot_detection/provision_bot_subjects.py — this just drives them.
//
// Usage (from bot_driver/, with `npm run dev` running in the repo root):
//   node src/fleet.js                       # headed, waves of 5, 3-min sessions
//   node src/fleet.js --headless true       # headless (faster, if lock holds)
//   node src/fleet.js --wave 3 --duration 3 # smaller waves
//
// The shared password is passed with --password (matches what provisioning
// printed). Each bot self-aborts if its aim is not converging, so a broken run
// fails loudly instead of writing junk — a failed bot is reported, not hidden.

import { runBot } from './run.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const VARIANTS = ['linear', 'smooth', 'bezier', 'overshoot', 'jitter'];
const ACCOUNTS_PER_VARIANT = 3;

// Build the 15-account roster. Emails match the provisioning convention
// bot-<variant>-<n>@aimprint-test.local; cohort = bot_<variant> is already set
// on each subject server-side, so it is not needed here. `only` (e.g.
// "bezier-1,overshoot-2") restricts the run to a subset — used to re-run only
// the bots that failed a previous pass, without redoing the ones that landed.
function roster(only) {
  const want = only ? new Set(only.split(',').map((s) => s.trim())) : null;
  const list = [];
  let seed = 1;
  for (const variant of VARIANTS) {
    for (let n = 1; n <= ACCOUNTS_PER_VARIANT; n++) {
      const key = `${variant}-${n}`;
      if (!want || want.has(key)) {
        list.push({ variant, email: `bot-${variant}-${n}@aimprint-test.local`, seed: seed });
      }
      seed++;
    }
  }
  return list;
}

async function main() {
  const url = arg('url', 'http://localhost:5173');
  const password = arg('password', 'botfleet2026');
  const durationMin = Number(arg('duration', '3'));
  const headless = arg('headless', 'false') === 'true';
  const waveSize = Number(arg('wave', '5'));
  const only = arg('only', null);

  const bots = roster(only);
  if (!bots.length) { console.log('No bots match --only filter.'); return; }
  console.log(`Fleet: ${bots.length} bots (${VARIANTS.length} variants × ${ACCOUNTS_PER_VARIANT}), ` +
              `${durationMin}-min flick sessions, waves of ${waveSize}, headless=${headless}`);

  const results = [];
  for (let i = 0; i < bots.length; i += waveSize) {
    const wave = bots.slice(i, i + waveSize);
    console.log(`\n=== Wave ${i / waveSize + 1}: ${wave.map((b) => b.variant + '-' + b.email.match(/-(\d)@/)[1]).join(', ')} ===`);
    const settled = await Promise.allSettled(wave.map((b) =>
      runBot({ url, email: b.email, password, routine: 'flick', difficulty: 'medium',
               durationMin, variant: b.variant, headless, seed: b.seed })
    ));
    settled.forEach((s, j) => {
      const b = wave[j];
      if (s.status === 'fulfilled') {
        results.push({ ...b, ok: true, shots: s.value.shots });
        console.log(`  OK   ${b.email}: ${s.value.shots} shots`);
      } else {
        results.push({ ...b, ok: false, error: String(s.reason?.message || s.reason) });
        console.log(`  FAIL ${b.email}: ${s.reason?.message || s.reason}`);
      }
    });
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== Fleet complete: ${ok.length}/${results.length} succeeded ====`);
  if (failed.length) {
    console.log('Failed bots (re-run these individually):');
    for (const f of failed) console.log(`  ${f.variant} ${f.email}: ${f.error}`);
  }
  console.log('Total shots:', ok.reduce((a, r) => a + r.shots, 0));
}

main().catch((err) => { console.error(err); process.exit(1); });
