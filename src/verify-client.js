// Post-session behavioural-biometric verification client.
//
// When a qualifying run ends, the browser POSTs that session's segment payloads
// to the deployed FastAPI /verify endpoint (Render). The endpoint reads the
// subject's template SERVER-SIDE with the service key and returns a trust
// result. The template never leaves the server — that is the one property that
// makes this defensible, so there is deliberately no client-side comparison here.
//
// This is a SECONDARY risk signal, never an authentication gate: canPlay() does
// not consult it, and the result only decorates the results screen. If the
// endpoint is not configured (VITE_VERIFY_URL unset) or unreachable, the feature
// is silently off — same spirit as "no Supabase creds → the app still runs".
//
// No new dependency: plain fetch, honouring the browser app's two-dependency
// rule (three + supabase-js).

// The resolved states the results badge renders. 'checking' is set by the UI
// before the call resolves; the rest are what verifySession() returns.
export const VERIFY_STATES = {
  OFF: 'off', // feature not configured — render no badge at all
  CHECKING: 'checking',
  MATCH: 'match',
  MISMATCH: 'mismatch',
  NOT_ENOUGH_HISTORY: 'not-enough-history', // 404 — subject not enrolled yet
  MODEL_NOT_READY: 'model-not-ready', // 503 — verifier artifact not trained yet
  UNAVAILABLE: 'unavailable' // network error / unexpected response
};

// import.meta.env is Vite-only; in the Node test harness import.meta.env is
// undefined, so optional-chain it rather than throw at import time.
function defaultVerifyUrl() {
  try {
    return import.meta.env?.VITE_VERIFY_URL ?? null;
  } catch {
    return null;
  }
}

// Fire-and-forget wake-up ping, sent when a run STARTS. A free-tier host (Render)
// spins the service down after idle and takes ~1 min to wake; the verify call
// only fires at run END, minutes later, so pinging /health now means the service
// is already awake by then and the cold start never lands on the user. Silent
// and best-effort: no await, no throw, no-op when unconfigured.
export function warmVerifyService({
  url = defaultVerifyUrl(),
  fetchImpl = typeof fetch === 'function' ? fetch : null
} = {}) {
  if (!url || !fetchImpl) return;
  const endpoint = `${url.replace(/\/$/, '')}/health`;
  // Deferred into a microtask so even a synchronous throw from fetchImpl becomes
  // a caught rejection — never surfacing to the caller or the render loop.
  Promise.resolve()
    .then(() => fetchImpl(endpoint, { method: 'GET', cache: 'no-store' }))
    .catch(() => {});
}

// Turns the verifier's raw distance into a 0–100 "match %" anchored on the
// model's OWN operating threshold: distance 0 → 100%, distance == threshold →
// 50% (the accept/reject line), distance ≥ 2×threshold → 0%. So accepts read
// above 50% and rejects below it, and the number is the real model output, not
// a fabricated one. It is a DEMO figure at the current data scale (EER ≈ 0.5):
// honest as "the model's similarity score", not as a validated confidence.
function matchPercentFromDistance(distance, threshold) {
  if (typeof distance !== 'number' || typeof threshold !== 'number' || threshold <= 0) {
    return null;
  }
  const pct = 100 * (1 - distance / (2 * threshold));
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Verifies one finished session. Returns { state, matchPercent } — matchPercent
// is null unless the call resolved to a real accept/reject verdict. Never throws
// and never blocks the caller (callers fire it without awaiting and fill the
// badge when it resolves). `url`/`fetchImpl` are injectable for tests.
export async function verifySession({
  subjectId,
  segments,
  url = defaultVerifyUrl(),
  fetchImpl = typeof fetch === 'function' ? fetch : null
}) {
  const result = (state, matchPercent = null) => ({ state, matchPercent });

  // Nothing to do, or no way to do it: stay silent (no badge).
  if (!url || !fetchImpl || !subjectId || !Array.isArray(segments) || segments.length === 0) {
    return result(VERIFY_STATES.OFF);
  }

  const endpoint = `${url.replace(/\/$/, '')}/verify`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: subjectId, segments })
    });
  } catch {
    // Network failure, CORS block, server down — all non-fatal here.
    return result(VERIFY_STATES.UNAVAILABLE);
  }

  if (response.status === 404) return result(VERIFY_STATES.NOT_ENOUGH_HISTORY);
  if (response.status === 503) return result(VERIFY_STATES.MODEL_NOT_READY);
  if (!response.ok) return result(VERIFY_STATES.UNAVAILABLE);

  let body;
  try {
    body = await response.json();
  } catch {
    return result(VERIFY_STATES.UNAVAILABLE);
  }
  // The endpoint returns { accept, distance, threshold, model_version, note }.
  if (typeof body?.accept !== 'boolean') return result(VERIFY_STATES.UNAVAILABLE);
  const matchPercent = matchPercentFromDistance(body.distance, body.threshold);
  return result(body.accept ? VERIFY_STATES.MATCH : VERIFY_STATES.MISMATCH, matchPercent);
}
