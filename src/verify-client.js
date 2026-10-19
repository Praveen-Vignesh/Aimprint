// Post-session behavioural-biometric verification client.
//
// When a qualifying run ends, the browser POSTs that session's segment payloads
// to the deployed FastAPI /verify endpoint (Railway). The endpoint reads the
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

// Verifies one finished session. Returns a VERIFY_STATES value; never throws and
// never blocks the caller's own flow (callers fire it without awaiting and fill
// the badge when it resolves). `url`/`fetchImpl` are injectable for tests.
export async function verifySession({
  subjectId,
  segments,
  url = defaultVerifyUrl(),
  fetchImpl = typeof fetch === 'function' ? fetch : null
}) {
  // Nothing to do, or no way to do it: stay silent (no badge).
  if (!url || !fetchImpl || !subjectId || !Array.isArray(segments) || segments.length === 0) {
    return VERIFY_STATES.OFF;
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
    return VERIFY_STATES.UNAVAILABLE;
  }

  if (response.status === 404) return VERIFY_STATES.NOT_ENOUGH_HISTORY;
  if (response.status === 503) return VERIFY_STATES.MODEL_NOT_READY;
  if (!response.ok) return VERIFY_STATES.UNAVAILABLE;

  let body;
  try {
    body = await response.json();
  } catch {
    return VERIFY_STATES.UNAVAILABLE;
  }
  // The endpoint returns { accept, distance, threshold, model_version, note }.
  if (typeof body?.accept !== 'boolean') return VERIFY_STATES.UNAVAILABLE;
  return body.accept ? VERIFY_STATES.MATCH : VERIFY_STATES.MISMATCH;
}
