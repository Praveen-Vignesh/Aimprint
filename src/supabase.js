import { createClient } from '@supabase/supabase-js';
import { createOutbox, createIdbStore } from './outbox.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// "Remember me": supabase-js has no per-sign-in persistence option, only a
// fixed storage backend set at client construction. This adapter picks that
// backend per call instead, from a flag written just before signIn/signUp/
// signInWithGoogle — localStorage (the prior, unconditional behaviour) unless
// the player unchecked "remember me", in which case the session lands in
// sessionStorage and disappears when the tab closes. Unset (new visitor,
// or the bot driver, which never touches the checkbox) reads as remembered,
// so the default behaviour is unchanged.
const REMEMBER_KEY = 'aim-trainer.remember';

function rememberedStorage() {
  try {
    return localStorage.getItem(REMEMBER_KEY) === '0' ? sessionStorage : localStorage;
  } catch {
    return localStorage;
  }
}

const dynamicStorage = {
  getItem: (key) => rememberedStorage().getItem(key),
  setItem: (key, value) => rememberedStorage().setItem(key, value),
  removeItem: (key) => rememberedStorage().removeItem(key)
};

export function setRememberMe(remember) {
  try {
    localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
  } catch {
    // Private mode / quota — falls back to the always-persisted default.
  }
}

// Without credentials the trainer still runs; rows are simply dropped.
const client =
  url && anonKey
    ? createClient(url, anonKey, {
        // detectSessionInUrl handles the Google OAuth redirect back to the app:
        // supabase-js reads the code/tokens Google appended to the URL, exchanges
        // them for a session, then strips them from the URL. A no-op for the
        // email/password path, whose URLs never carry those params. The same
        // mechanism is what detects a password-recovery link's return trip.
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: dynamicStorage
        }
      })
    : null;

if (client === null) {
  console.warn(
    'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local to persist telemetry.'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// v2 collects data only from real accounts. Anonymous sign-in was removed: with
// no auth session, ensureAuth() resolves null and every write is dropped, so an
// unauthenticated (free) session persists nothing at all — the guarantee that no
// anonymous rows reach the table. The handle_new_user() trigger creates the
// subject + profile for a real email signup exactly as it did for anonymous
// users, so the schema needs no change for this.

let accessToken = null;
// The user_id signed in right now, cached from onAuthStateChange so the outbox
// can scope queued rows to their owner SYNCHRONOUSLY (createOutbox currentOwner).
// On a shared recruitment machine this is what stops one participant's queued
// rows being thrown at the database under the next participant's token.
let currentUserId = null;

function currentOwner() {
  return currentUserId;
}

// { status: 'loading' | 'signed_in' | 'signed_out', email, userId, isRecovery }
//
// There is no `consented` field any more. The consent system — both column
// pairs, the version constant, the mirror trigger and the gate that read
// them — was removed on 2026-10-18. Agreement is now part of creating an
// account, stated on the sign-up card, with nothing to record or re-check at
// runtime. Playing requires a signed-in account and nothing else.
//
// `isRecovery` is true for the session a password-reset link hands back —
// that session is real (status is still 'signed_in'), but the caller must
// treat it as "needs a new password", not "ready to play": landing.js checks
// it to hold the player on the reset form instead of redirecting to /play.
let currentAuth = {
  status: client === null ? 'signed_out' : 'loading',
  email: null,
  userId: null,
  isRecovery: false
};
const authListeners = new Set();

// Memoised subject resolution for the current auth user. Reset to null on any
// auth change so a new sign-in re-resolves against the right profile.
let subjectPromise = null;

export function getAuthState() {
  return { ...currentAuth };
}

// Subscribe to auth changes. The callback fires immediately with the current
// state and on every subsequent change; returns an unsubscribe function.
export function onAuthChange(callback) {
  authListeners.add(callback);
  callback(getAuthState());
  return () => authListeners.delete(callback);
}

function notifyAuth() {
  for (const callback of authListeners) callback(getAuthState());
}

if (client !== null) {
  // Fires INITIAL_SESSION on subscribe (supabase-js v2), so currentAuth leaves
  // 'loading' as soon as the persisted session is read from localStorage.
  client.auth.onAuthStateChange((event, session) => {
    accessToken = session?.access_token ?? null;
    currentUserId = session?.user?.id ?? null;

    if (session?.user) {
      // TOKEN_REFRESHED fires roughly hourly, and supabase-js also re-emits for
      // the same account (INITIAL_SESSION then SIGNED_IN on a fresh load).
      // Re-resolving the profile on those is pointless work for an account that
      // has not changed, so only a real change of account does it.
      const sameUser =
        currentAuth.status === 'signed_in' && currentAuth.userId === session.user.id;

      if (sameUser) {
        currentAuth = { ...currentAuth, email: session.user.email ?? currentAuth.email };
        notifyAuth();
        return;
      }

      subjectPromise = null;
      currentAuth = {
        status: 'signed_in',
        email: session.user.email ?? null,
        userId: session.user.id,
        isRecovery: event === 'PASSWORD_RECOVERY'
      };
      notifyAuth();
      // This account is now the current owner, so any rows held for it (from a
      // prior tab or a previous participant's turn on this machine) can deliver.
      //
      // Deferred out of this callback ON PURPOSE, and it must stay deferred.
      // supabase-js invokes auth state callbacks while holding its internal auth
      // lock, so anything calling back into client.auth.* from in here contends
      // with that lock and runs against a session that is not ready yet. The
      // deferral is also what guarantees the outbox consts below are
      // initialised by the time this fires.
      setTimeout(kickOutboxes, 0);
      return;
    }

    subjectPromise = null;
    currentAuth = { status: 'signed_out', email: null, userId: null, isRecovery: false };
    notifyAuth();
  });
}

function resolveSubjectFor(user) {
  // The trigger creates the profile in the same transaction as the auth user,
  // so it is normally present immediately; retry briefly against any lag.
  return (async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await client
        .from('profiles')
        .select('subject_id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error === null && data) {
        return { userId: user.id, subjectId: data.subject_id };
      }
      lastError = error;
      await sleep(200);
    }

    // The specific failure is what distinguishes the two causes, and swallowing
    // it is why this was invisible: a 401/PGRST301 means the token was not
    // attached yet (transient, and the caller must not cache the null), while a
    // clean empty result means the on_auth_user_created trigger genuinely never
    // made a profile row for this account (permanent, needs a server-side fix).
    console.warn(
      'Supabase profile row not resolved for the signed-in user; telemetry dropped.',
      lastError
        ? `Last error: ${lastError.code ?? 'no code'} — ${lastError.message}`
        : 'No error, but no row returned — this account has no profiles row.'
    );
    return null;
  })();
}

// Resolves to { userId, subjectId } when a real account is signed in, or null.
// Null is the "drop this write" signal — no anonymous fallback exists.
function ensureAuth() {
  if (client === null) return Promise.resolve(null);
  if (subjectPromise === null) {
    const pending = (async () => {
      const { data } = await client.auth.getSession();
      const user = data.session?.user ?? null;
      if (user === null) return null;
      return resolveSubjectFor(user);
    })();

    subjectPromise = pending;

    // A null result is a FAILURE, not an answer, so it is deliberately not
    // memoised. This read can fail transiently — the session may still be
    // restoring, or the access token may not be attached yet — and caching that
    // null poisons every later call for the rest of the page's life: session
    // inserts and segment writes all keep resolving null with no retry, until
    // an auth event happens to clear it. Only a real resolution sticks.
    pending.then((auth) => {
      if (auth === null && subjectPromise === pending) subjectPromise = null;
    });
  }
  return subjectPromise;
}

// Returns {} on success, { error } (a message) on failure, or { needsConfirmation:true }
// when the project requires email confirmation and no session was issued yet.
// `fullName` has no column anywhere (subjects/profiles carry no name field),
// so it is stored only as Supabase auth user_metadata — a schema-free,
// optional label on the account, never training data.
export async function signUp({ email, password, fullName }) {
  if (client === null) return { error: 'Supabase is not configured.' };
  const trimmedName = typeof fullName === 'string' ? fullName.trim() : '';
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: trimmedName === '' ? undefined : { data: { full_name: trimmedName } }
  });
  if (error) return { error: error.message };

  // With "Confirm email" ON, Supabase does NOT reject a signup for an address
  // that already has an account — it returns a decoy success, so the endpoint
  // cannot be used to enumerate registered emails. The tell is an empty
  // `identities` array on the returned user; a genuine new signup always has
  // exactly one. Without this check the panel tells a returning player "Account
  // created, check your email" and no email ever arrives, because none was sent.
  //
  // Reporting it does make enumeration possible against this project. That is a
  // deliberate trade-off: the cohort is ~50 recruited participants, and silently
  // swallowing a returning player's signup costs a session, which is the scarce
  // resource here.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { error: 'That email already has an account — sign in instead.' };
  }

  return { needsConfirmation: data.session === null };
}

export async function signIn({ email, password }) {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  return {};
}

// Redirects the browser to Google and never resolves on success (the page
// navigates away); a rejected promise here means the redirect itself couldn't
// start (e.g. the provider isn't configured in the Supabase dashboard).
export async function signInWithGoogle() {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) return { error: error.message };
  return {};
}

export async function signOut() {
  if (client === null) return;
  await client.auth.signOut();
}

// Sends the reset-password email. `redirectTo` is the bare origin, same as
// signInWithGoogle — there is no dedicated reset page (this is a static,
// three-entry build with no router), so the link lands back on `/` and
// detectSessionInUrl turns it into a PASSWORD_RECOVERY auth event there.
export async function requestPasswordReset(email) {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin
  });
  if (error) return { error: error.message };
  return {};
}

// Finishes the recovery flow started by requestPasswordReset: called while
// the recovery session (isRecovery: true) is active. Clears the flag on
// success so the caller's next render treats the account as a normal
// signed-in session rather than still "mid reset".
export async function updatePassword(newPassword) {
  if (client === null) return { error: 'Supabase is not configured.' };
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) return { error: error.message };
  currentAuth = { ...currentAuth, isRecovery: false };
  notifyAuth();
  return {};
}

// supabase-js restores the persisted session from localStorage and emits
// INITIAL_SESSION without asking the server whether it is still valid, so a
// deleted or revoked account still renders as signed in — and then silently
// records nothing, because ensureAuth() can resolve no profile for it.
// getUser() is the round-trip getSession() deliberately skips, and is what
// corrects the state on boot.
//
// Only a definitive rejection signs out. A network failure leaves the session
// alone: discarding a good session because the wifi dropped would be worse than
// the bug this fixes. Same permanent-vs-transient split the outbox makes on
// SQLSTATE — a retryable fetch error carries no 401/403 and so falls through.
export async function validateSession() {
  if (client === null) return;

  const { data } = await client.auth.getSession();
  if (data.session === null) return;

  const { error } = await client.auth.getUser();
  if (error === null || error === undefined) return;
  if (error.status !== 401 && error.status !== 403) return;

  console.warn('Stored session is no longer valid; signing out:', error.message);
  // Local scope only. The server-side session is already gone in this case, so a
  // global sign-out would call an endpoint that rejects it.
  await client.auth.signOut({ scope: 'local' });
}

// There is no session-close path. The client writes a session row once (at
// insert) and never updates it — the schema has no UPDATE policy on sessions.
// `poll_hz` (the one service-written column that was briefly client-closed) is
// derived offline with the service key: queries/campaign.sql section 5 and the
// archive job, which already decodes every segment. `ended_at` was dropped
// entirely on 2026-10-18.

// ---------------------------------------------------------------------------
// Telemetry delivery
// ---------------------------------------------------------------------------

// The segment insert: a plain INSERT, deliberately NOT an upsert. PostgREST
// switches to its upsert path on the Prefer: resolution=... header alone (the
// on_conflict query param is inert without it), and that path is refused with
// 42501 on this table under both resolutions — it needs SELECT/UPDATE policies
// that `segments` withholds on purpose, since a trajectory is the raw material
// of a biometric template. The identical row inserts fine without the header.
//
// Idempotency comes from the unique (session_id, segment_index) instead: a
// re-sent row raises 23505, which the outbox reads as "already delivered". No
// .select() either — segments has no read policy, so asking for the rows back
// would fail even though the write is allowed.
async function sendSegments(rows) {
  const { error } = await client.from('segments').insert(rows);

  if (error) {
    // The SQLSTATE is what tells the outbox whether a retry can ever succeed: an
    // RLS rejection (42501) is permanent, a dropped connection is not. Flattening
    // this to a bare message is what let one undeliverable row retry forever.
    const failure = new Error(error.message);
    failure.code = error.code;
    failure.details = error.details;
    throw failure;
  }
}

// Best-effort delivery during page unload. supabase-js does not expose keepalive,
// so this hits PostgREST directly with keepalive:true, which an unloading page is
// still allowed to finish. The token is cached from onAuthStateChange because
// this must run synchronously — no await on getSession().
function sendSegmentsKeepalive(rows) {
  if (accessToken === null || typeof fetch === 'undefined') return;

  fetch(`${url}/rest/v1/segments`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(rows)
  }).catch(() => {});
}

// The session insert. A plain INSERT like segments, and idempotent the same way:
// the id is the primary key (minted by game.js), so a re-sent session raises
// 23505, which the outbox settles as "already delivered". No .select(): keeping
// it minimal, and it means a segment's session can land without a read round
// trip. The row is durable now (its own outbox + IndexedDB store), so a
// transient failure at the start of a run no longer discards the whole session.
async function sendSessions(rows) {
  const { error } = await client.from('sessions').insert(rows);

  if (error) {
    const failure = new Error(error.message);
    failure.code = error.code;
    failure.details = error.details;
    throw failure;
  }
}

// Keepalive counterpart for session rows (tiny; a run has one). Delivering the
// session on unload means the next load's segment replay does not 23503-wait.
function sendSessionsKeepalive(rows) {
  if (accessToken === null || typeof fetch === 'undefined') return;

  fetch(`${url}/rest/v1/sessions`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(rows)
  }).catch(() => {});
}

// Nudges both queues to deliver. Called when an account signs in (its held rows
// can now go) and reused by the exported flushes. A hoisted declaration so the
// auth callback above can name it; it only reads the outbox consts below when
// actually invoked (always via setTimeout), by which point they are initialised.
function kickOutboxes() {
  if (sessionOutbox !== null) sessionOutbox.flush();
  if (outbox !== null) outbox.flush();
}

// One IndexedDB database, two object stores — segments and the session rows they
// reference — each with its own outbox. currentOwner scopes both queues to the
// signed-in account (see outbox.js).
const idb = client === null ? null : createIdbStore();

const outbox =
  client === null
    ? null
    : createOutbox({
        send: sendSegments,
        sendKeepalive: sendSegmentsKeepalive,
        store: idb === null ? null : idb.forStore('segments'),
        currentOwner,
        onError: (error) => console.warn('Segment batch delivery failed, will retry:', error.message),
        onDrop: (row, error) =>
          console.warn(
            `Segment ${row.session_id}:${row.segment_index} was rejected permanently ` +
              `(${error.code}) and has been dropped:`,
            error.message
          )
      });

const sessionOutbox =
  client === null
    ? null
    : createOutbox({
        send: sendSessions,
        sendKeepalive: sendSessionsKeepalive,
        store: idb === null ? null : idb.forStore('sessions'),
        // A session's idempotency key is its own id, not (session_id, index).
        keyOf: (row) => row.id,
        isValid: (row) => row !== null && row !== undefined && row.id !== null && row.id !== undefined,
        currentOwner,
        onError: (error) => console.warn('Session delivery failed, will retry:', error.message),
        onDrop: (row, error) =>
          console.warn(
            `Session ${row.id} was rejected permanently (${error.code}) and has been dropped:`,
            error.message
          )
      });

// Replays anything a previous page load left unacknowledged in IndexedDB.
// Sessions first, so a replayed segment finds its session already present rather
// than taking the 23503-wait round trip (it would still recover, via the
// transient-FK retry, but this is cheaper).
export function initTelemetryOutbox() {
  if (sessionOutbox !== null) sessionOutbox.init();
  if (outbox !== null) outbox.init();
}

// A prompt flush (e.g. at session end) and a keepalive flush (page unload). Both
// cover the session queue and the segment queue.
export function flushTelemetry() {
  if (sessionOutbox !== null) sessionOutbox.flush();
  if (outbox !== null) outbox.flush();
}

export function flushTelemetryKeepalive() {
  if (sessionOutbox !== null) sessionOutbox.flushKeepalive();
  if (outbox !== null) outbox.flushKeepalive();
}

// Hands a session row to the durable session outbox. The id is already on the
// payload (minted by game.js), so this no longer resolves and returns one — the
// segments reference the client-minted id directly and never wait on the insert.
// A failed delivery is retried from IndexedDB instead of discarding the whole
// run, which is the bug this replaces. subject_id is stamped here from the
// resolved profile so the RLS insert check (subject_id = current_subject_id())
// passes, and the owner is recorded for queue scoping.
//
// A null auth means no profile resolved for the signed-in account — the row
// cannot satisfy RLS and there is nothing to deliver, so it is skipped. In the
// normal path the game only starts for a signed-in account, so auth resolves;
// this guards the edge where it does not.
// The signed-in account's pseudonymous subject_id, or null when not resolvable
// (not signed in, Supabase unconfigured, or the profile row has not resolved).
// The browser names the subject in the post-session biometric verify call; it
// never reads or writes the service-key-only biometric_templates table itself.
// Reuses ensureAuth()'s resolution so it costs no extra round trip mid-run.
export async function getSubjectId() {
  const auth = await ensureAuth();
  return auth === null ? null : auth.subjectId;
}

export async function insertSession(payload) {
  if (sessionOutbox === null) return;

  const auth = await ensureAuth();
  if (auth === null) {
    console.warn(
      'Session not queued: no profile resolved for the signed-in account; its telemetry cannot be delivered.'
    );
    return;
  }

  sessionOutbox.enqueue({ ...payload, subject_id: auth.subjectId }, auth.userId);
}

// Hands one segment row to the durable outbox. Synchronous now: the session id
// is known at the call site (minted in game.js), so there is no promise to await
// and the game loop never blocks. The segment may reach the database before its
// session row — a 23503 the outbox treats as transient and retries. The owning
// user is recorded in the envelope for queue scoping.
export function insertSegment(sessionId, payload) {
  if (outbox === null || sessionId === null || sessionId === undefined) return;

  outbox.enqueue({ ...payload, session_id: sessionId }, currentUserId);
}
