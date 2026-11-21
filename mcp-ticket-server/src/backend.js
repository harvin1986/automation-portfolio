'use strict';
// HTTP client for the ticketing API. Owns everything that is about talking to a remote system:
// auth, timeouts, bounded retries with Retry-After, and turning HTTP failures into typed errors
// whose messages are safe and useful for a model to read (never include the token).

class ApiError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.details = details; }
}

class HttpBackend {
  constructor({ baseUrl, token, timeoutMs = 8000, retries = 2, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, ''); this.token = token; this.timeoutMs = timeoutMs; this.retries = retries; this.fetch = fetchImpl; this.sleep = sleep;
  }

  async request(method, path, { query, body, headers = {}, retry = false } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const attempts = retry ? this.retries + 1 : 1;
    let last;
    for (let i = 0; i < attempts; i++) {
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(url, { method, signal: ac.signal, headers: { accept: 'application/json', authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
        if (res.ok) return data;
        const e = data && data.error ? data.error : {};
        last = new ApiError(res.status, e.code || 'http_' + res.status, e.message || `HTTP ${res.status}`, { allowed: e.allowed });
        if (![429, 502, 503, 504].includes(res.status) || i === attempts - 1) throw last;
        const ra = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 2) * 1000 : 200 * 2 ** i);
      } catch (e) {
        if (e instanceof ApiError) { if (i === attempts - 1 || ![429, 502, 503, 504].includes(e.status)) throw e; last = e; continue; }
        last = new ApiError(0, e.name === 'AbortError' ? 'timeout' : 'network', e.name === 'AbortError' ? `request timed out after ${this.timeoutMs}ms` : 'could not reach the ticketing API');
        if (i === attempts - 1) throw last;
        await this.sleep(200 * 2 ** i);
      } finally { clearTimeout(timer); }
    }
    throw last;
  }

  search(p) { return this.request('GET', '/tickets', { query: p, retry: true }); }
  get(id) { return this.request('GET', `/tickets/${encodeURIComponent(id)}`, { retry: true }); }
  stats() { return this.request('GET', '/stats', { retry: true }); }
  create(input, key) { return this.request('POST', '/tickets', { body: input, headers: { 'idempotency-key': key }, retry: true }); } // safe to retry: idempotency key
  setStatus(id, status) { return this.request('PATCH', `/tickets/${encodeURIComponent(id)}`, { body: { status }, retry: true }); } // idempotent by nature
  comment(id, body, author) { return this.request('POST', `/tickets/${encodeURIComponent(id)}/comments`, { body: { body, author } }); } // NOT retried: would duplicate
}

module.exports = { HttpBackend, ApiError };
