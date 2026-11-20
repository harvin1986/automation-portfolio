// Claude Messages API client with retry/backoff. The agent only depends on the function this returns,
// so tests can swap in a scripted model.

function createModel({ apiKey, model = 'claude-sonnet-5-5', fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 3 } = {}) {
  return async function callModel({ system, messages, tools }) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          // 'auto': newer models reject a forced tool_choice.
          body: JSON.stringify({ model, max_tokens: 2000, system, messages, tools, tool_choice: { type: 'auto' } }),
          signal: AbortSignal.timeout(60000),
        });
        if (res.ok) return res.json();
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new Error('Claude API ' + res.status + ': ' + (await res.text()).slice(0, 200));
        if (!retryable) throw lastErr;
      } catch (e) {
        lastErr = e;
        if (/Claude API 4\d\d/.test(e.message) && !/429/.test(e.message)) throw e;
      }
      if (attempt < retries - 1) await sleep(1000 * 2 ** attempt);
    }
    throw lastErr;
  };
}

module.exports = { createModel };
