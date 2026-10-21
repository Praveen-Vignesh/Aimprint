// Post-session bot/human readout client — the demo-facing sibling of
// verify-client.js.
//
// When a qualifying run ends, the browser POSTs that session's segment payloads
// (plus the player's subject_id — segments are session-scoped so they carry no
// id of their own) to the deployed FastAPI /bot-score endpoint. The service
// scores the run with the offline-trained bot detector and returns a per-subject
// verdict. Shown on the results screen as a quiet "looks human / looks
// synthetic" readout.
//
// ⚠️ DEMO POSTURE: the real design keeps a player from ever seeing their own bot
// score (a bot that reads its score can evade). This readout deliberately
// relaxes that for the recruiter demo. It is NOT a gate — canPlay() never
// consults it — and it is silently off when VITE_VERIFY_URL is unset or the
// model is not trained.
//
// No new dependency: plain fetch, honouring the two-dependency rule.

export const BOT_STATES = {
  OFF: 'off', // feature not configured — render no readout
  CHECKING: 'checking',
  HUMAN: 'human',
  SYNTHETIC: 'synthetic',
  MODEL_NOT_READY: 'model-not-ready', // 503 — detector not trained yet
  UNAVAILABLE: 'unavailable' // network error / unexpected response
};

// Same endpoint base as the verify client (same Render service, different path).
function defaultVerifyUrl() {
  try {
    return import.meta.env?.VITE_VERIFY_URL ?? null;
  } catch {
    return null;
  }
}

// Scores one finished session. Returns { state, botProbability } — botProbability
// is null unless the call resolved to a real verdict. Never throws and never
// blocks the caller (fired without awaiting; the UI fills in when it resolves).
export async function scoreRun({
  subjectId,
  segments,
  url = defaultVerifyUrl(),
  fetchImpl = typeof fetch === 'function' ? fetch : null
}) {
  if (!url || !fetchImpl || !subjectId || !Array.isArray(segments) || segments.length === 0) {
    return { state: BOT_STATES.OFF, botProbability: null };
  }

  const endpoint = `${url.replace(/\/$/, '')}/bot-score`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: subjectId, segments })
    });
  } catch {
    return { state: BOT_STATES.UNAVAILABLE, botProbability: null };
  }

  if (response.status === 503) return { state: BOT_STATES.MODEL_NOT_READY, botProbability: null };
  if (!response.ok) return { state: BOT_STATES.UNAVAILABLE, botProbability: null };

  let body;
  try {
    body = await response.json();
  } catch {
    return { state: BOT_STATES.UNAVAILABLE, botProbability: null };
  }

  // The endpoint returns { predictions: [ { predicted_label, bot_probability, ... } ] }.
  const prediction = Array.isArray(body?.predictions) ? body.predictions[0] : null;
  if (!prediction || typeof prediction.predicted_label !== 'string') {
    return { state: BOT_STATES.UNAVAILABLE, botProbability: null };
  }
  const botProbability =
    typeof prediction.bot_probability === 'number' ? prediction.bot_probability : null;
  const state = prediction.predicted_label === 'synthetic' ? BOT_STATES.SYNTHETIC : BOT_STATES.HUMAN;
  return { state, botProbability };
}
