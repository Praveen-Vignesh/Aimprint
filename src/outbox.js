// Durable, batched, idempotent delivery of rows to Supabase. Used for two
// streams — segments and the session rows they reference — each with its own
// outbox instance and its own IndexedDB object store.
//
// The old path inserted each segment fire-and-forget and logged a warning on
// failure — so a network blip or a tab closed mid-session silently dropped the
// play it had just recorded. Since the whole project exists to collect that
// data, and it cannot be re-collected, the loss is the bug. Four properties make
// delivery safe here:
//
//   - Idempotent. A batch is delivered as a plain INSERT, and a unique key
//     (segments: (session_id, segment_index); sessions: id) turns a re-sent row
//     into a 23505, read as "already delivered" rather than as a failure. An
//     upsert would be the obvious way to say this, but PostgREST enters its
//     upsert path on the Prefer: resolution=... header alone, and that path
//     needs SELECT/UPDATE policies these tables deliberately withhold — both
//     resolutions are refused with 42501 while the identical plain INSERT
//     succeeds. A partially delivered batch can therefore still be retried whole.
//   - Persistent. The pending queue is mirrored to IndexedDB, which is async and
//     off the main thread — unlike localStorage, whose synchronous write would
//     hitch the render loop that the timing features are measured from. A reload
//     replays whatever had not been acknowledged.
//   - Owner-scoped. Each queued row carries, in its IndexedDB envelope (never in
//     the row itself), the user_id it belongs to. A row whose owner is not the
//     currently signed-in user is HELD, not attempted — so on a shared machine,
//     participant A's undelivered rows are not thrown at the database under
//     participant B's token (which would 42501 and permanently drop them).
//   - Flushed on exit. flushKeepalive() sends a bounded last batch with a
//     keepalive fetch, which an unloading page is still allowed to complete.
//
// The senders and the store are injected so the module runs headlessly in a
// Node harness with plain stubs.

// Exponential backoff between failed flush attempts, capped. Reset on success.
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30000;
// Rows accumulate for this long before a flush, so a burst of segments becomes
// one request instead of one request each. Raised from 400 ms: tracking emits a
// segment roughly every second, so at 400 ms the debounce always fired with a
// single row (~one POST per segment). A few seconds batches ~5 rows per request
// with no added risk — rows are persisted to IndexedDB on enqueue and flushed on
// pause, on run end, and on page unload, so nothing waits on this timer to be
// durable. A full batch still flushes immediately.
const FLUSH_DEBOUNCE_MS = 5000;
const DEFAULT_BATCH_SIZE = 25;
// Keepalive request bodies are capped (~64 KiB per origin, cumulative across
// in-flight keepalive fetches). A couple of segments already exceed that, so the
// unload flush fills ONE request to a budget under the cap and leaves the rest
// to replay from IndexedDB on the next load.
const KEEPALIVE_BUDGET_BYTES = 60000;

// SQLSTATE classes a retry can never fix: 22 (data exception), 23 (integrity
// constraint violation) and 42 (access rule violation — an RLS rejection lands
// here as 42501). A queued row's payload is frozen, so re-sending it reproduces
// the identical rejection forever while blocking every row behind it. Anything
// else — a dropped connection with no code at all, a 5xx, an expired JWT
// (PGRST301) — is transient and keeps its backoff-and-retry.
const PERMANENT_SQLSTATE = /^(22|23|42)\d/;

// 23503 (foreign_key_violation) is in class 23 but is TRANSIENT here: a segment
// can reach the database a moment before its session row (the two travel in
// separate outboxes), and "the session has not landed yet" is a wait, not a
// permanent failure. It resolves the instant the session insert succeeds. This
// exception is what makes the client-minted session id + separate session outbox
// safe; without it the first segments of every run would be dropped.
const TRANSIENT_SQLSTATE = new Set(['23503']);

function isPermanent(error) {
  const code = error?.code;
  if (typeof code !== 'string') return false;
  if (TRANSIENT_SQLSTATE.has(code)) return false;
  return PERMANENT_SQLSTATE.test(code);
}

// unique_violation: this row already landed on an earlier attempt. It is inside
// the permanent class above, but it means the opposite of the rest of that class
// — delivery succeeded, just not on this request — so it settles the row instead
// of discarding it. This is what keeps a retried batch idempotent now that
// delivery is a plain INSERT.
const DUPLICATE_SQLSTATE = '23505';

function isDuplicate(error) {
  return error?.code === DUPLICATE_SQLSTATE;
}

function approxSize(row) {
  try {
    return JSON.stringify(row).length;
  } catch {
    return KEEPALIVE_BUDGET_BYTES; // unserialisable: treat as large, send alone.
  }
}

// IndexedDB-backed store factory. Opens one database holding an object store per
// name, and hands out a per-store { put, delete, loadAll } interface. Returns
// null if IndexedDB is unavailable or errors on open, so the outbox degrades to
// memory-only rather than breaking play — the same posture settings.js takes
// with localStorage.
//
// The database name 'aim-trainer-outbox' is LOAD-BEARING and must never change:
// renaming it orphans telemetry already queued in users' browsers,
// unrecoverably. The version is bumped to 2 to add the 'sessions' store
// alongside the original 'segments' store; onupgradeneeded only CREATES missing
// stores, so a returning user's queued segments are preserved.
export function createIdbStore(dbName = 'aim-trainer-outbox', storeNames = ['segments', 'sessions']) {
  if (typeof indexedDB === 'undefined') return null;

  let dbPromise = null;

  function open() {
    if (dbPromise !== null) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of storeNames) {
          if (db.objectStoreNames.contains(name) === false) {
            db.createObjectStore(name);
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function run(storeName, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, mode);
          const store = transaction.objectStore(storeName);
          const outcome = fn(store);
          transaction.oncomplete = () => resolve(outcome());
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        })
    );
  }

  function forStore(storeName) {
    return {
      put(key, value) {
        return run(storeName, 'readwrite', (store) => {
          store.put(value, key);
          return () => undefined;
        });
      },

      delete(keys) {
        return run(storeName, 'readwrite', (store) => {
          for (const key of keys) store.delete(key);
          return () => undefined;
        });
      },

      loadAll() {
        return run(storeName, 'readonly', (store) => {
          const keysRequest = store.getAllKeys();
          const valuesRequest = store.getAll();
          return () => {
            const keys = keysRequest.result;
            const values = valuesRequest.result;
            const entries = [];
            for (let i = 0; i < keys.length; i++) {
              entries.push({ key: keys[i], value: values[i] });
            }
            return entries;
          };
        });
      }
    };
  }

  return { forStore };
}

// Normalises a stored value into an { owner, row } envelope. Values written by
// an older build are bare rows (no envelope), so they are adopted with a null
// owner, which means "attempt it" — best-effort, matching the old behaviour.
function toEnvelope(value) {
  if (value !== null && typeof value === 'object' && 'row' in value && 'owner' in value) {
    return value;
  }
  return { owner: null, row: value };
}

// send(rows)          -> Promise, resolves on success, rejects to trigger retry.
// sendKeepalive(rows) -> best-effort synchronous send for page unload (optional).
// store               -> { put, delete, loadAll } persistence (optional).
// keyOf(row)          -> the stable idempotency key (default: segment key).
// isValid(row)        -> whether a row is enqueueable (default: has session_id).
// currentOwner()      -> the user_id allowed to deliver right now, or null.
export function createOutbox({
  send,
  sendKeepalive = null,
  store = null,
  batchSize = DEFAULT_BATCH_SIZE,
  keyOf = (row) => `${row.session_id}:${row.segment_index}`,
  isValid = (row) => row !== null && row !== undefined && row.session_id !== null && row.session_id !== undefined,
  currentOwner = () => null,
  onError = () => {},
  onDrop = () => {}
}) {
  // key -> { owner, row }
  const pending = new Map();
  let flushing = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let flushTimer = null;
  let retryTimer = null;

  function persistPut(key, envelope) {
    if (store === null) return;
    Promise.resolve(store.put(key, envelope)).catch(() => {});
  }

  function persistDelete(keys) {
    if (store === null || keys.length === 0) return;
    Promise.resolve(store.delete(keys)).catch(() => {});
  }

  // Whether this envelope may be delivered under the current identity. A null
  // owner (legacy row) is always attempted; a set owner must match the signed-in
  // user, which also holds (skips) every owned row while nobody is signed in.
  function deliverable(envelope, owner) {
    return envelope.owner == null || envelope.owner === owner;
  }

  function scheduleFlush() {
    if (pending.size >= batchSize) {
      flush();
      return;
    }
    if (flushTimer !== null || typeof setTimeout === 'undefined') return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  function scheduleRetry() {
    if (typeof setTimeout === 'undefined') return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  // Drains the queue in batches. A TRANSIENT failure stops the drain and
  // schedules a backed-off retry, leaving the rest (and the failed one) in
  // `pending` and in the store so nothing is lost.
  //
  // A PERMANENT rejection cannot be waited out, so it gets the opposite
  // treatment: the batch is re-sent one row at a time to find which rows are
  // actually bad, and those are dropped. Without this, one undeliverable row
  // blocks every row behind it for the life of the browser profile.
  //
  // Rows belonging to another account are skipped while building each batch, so
  // they neither block the queue nor get thrown at the database under the wrong
  // identity. If a full pass finds nothing deliverable, the drain stops (they
  // wait for their owner to sign back in, which kicks a flush).
  async function flush() {
    if (flushing || pending.size === 0) return;
    flushing = true;
    const owner = currentOwner();
    // Isolation persists for the rest of this drain: bad rows arrive in runs
    // (one orphaned session's segments are contiguous), so returning to full
    // batches after each drop would re-fail a whole batch once per bad row.
    let isolating = false;

    try {
      while (pending.size > 0) {
        const limit = isolating ? 1 : batchSize;
        const keys = [];
        const rows = [];
        for (const [key, envelope] of pending) {
          if (deliverable(envelope, owner) === false) continue;
          keys.push(key);
          rows.push(envelope.row);
          if (rows.length >= limit) break;
        }

        // Nothing deliverable under the current identity — leave everything
        // queued for when its owner returns.
        if (rows.length === 0) return;

        try {
          await send(rows);
        } catch (error) {
          if (isPermanent(error) === false) {
            onError(error);
            scheduleRetry();
            return;
          }
          if (rows.length > 1) {
            isolating = true;
            continue;
          }
          // Alone and still rejected. A unique violation means the row is
          // already in the table, which is delivery, not loss. Anything else is
          // genuinely undeliverable, and discarding it is the only way the rows
          // behind it can ever move.
          if (isDuplicate(error) === false) onDrop(rows[0], error);
        }

        for (const key of keys) pending.delete(key);
        persistDelete(keys);
        backoffMs = INITIAL_BACKOFF_MS;
      }
    } finally {
      flushing = false;
    }
  }

  return {
    // Queue one already-assembled row. `owner` is the user_id it belongs to,
    // stored in the envelope (never in the row). Callers must not enqueue an
    // invalid row — there would be no valid row to insert and no way to replay it.
    enqueue(row, owner = null) {
      if (isValid(row) === false) return;
      const key = keyOf(row);
      const envelope = { owner: owner ?? null, row };
      pending.set(key, envelope);
      persistPut(key, envelope);
      scheduleFlush();
    },

    // Rehydrate anything a previous page load left unacknowledged, then flush.
    async init() {
      if (store === null) return;
      let entries = [];
      try {
        entries = await store.loadAll();
      } catch {
        return;
      }
      for (const { key, value } of entries) {
        if (pending.has(key) === false) pending.set(key, toEnvelope(value));
      }
      if (pending.size > 0) flush();
    },

    flush,

    // Best-effort synchronous send on page unload, bounded to the keepalive body
    // cap and scoped to the current owner. Oldest rows first (Map preserves
    // insertion order); the rest stay persisted and replay on the next load.
    flushKeepalive() {
      if (pending.size === 0 || sendKeepalive === null) return;
      const owner = currentOwner();
      const rows = [];
      let bytes = 0;
      for (const envelope of pending.values()) {
        if (deliverable(envelope, owner) === false) continue;
        const size = approxSize(envelope.row);
        if (rows.length > 0 && bytes + size > KEEPALIVE_BUDGET_BYTES) break;
        rows.push(envelope.row);
        bytes += size;
      }
      if (rows.length === 0) return;
      try {
        sendKeepalive(rows);
      } catch {
        // Rows remain persisted; next load retries them.
      }
    },

    size() {
      return pending.size;
    }
  };
}
