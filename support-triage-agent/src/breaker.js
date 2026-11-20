// Circuit breaker for the LLM call. After repeated failures, stop calling the model for a cool-down
// period and send tickets straight to a human instead of burning retries and timeouts.

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

function isOpen(state, nowMs) { return !!state && state.openUntil > nowMs; }

function recordFailure(state, nowMs) {
  state.failures = (state.failures || 0) + 1;
  if (state.failures >= FAILURE_THRESHOLD) { state.openUntil = nowMs + COOLDOWN_MS; state.failures = 0; }
}

function recordSuccess(state) { state.failures = 0; state.openUntil = 0; }

// --- exports (dropped when inlined into n8n) ---
module.exports = { isOpen, recordFailure, recordSuccess, FAILURE_THRESHOLD, COOLDOWN_MS };
