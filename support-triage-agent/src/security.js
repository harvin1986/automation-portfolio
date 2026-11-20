// Request authentication and input validation. Needs hmac.js inlined above it in n8n.
const { utf8, hmacSha256Hex, safeEqual } = require("./hmac");

const TOLERANCE_SEC = 300; // reject requests older (or newer) than 5 minutes: blocks replays

// Signature scheme (same idea as Stripe/Slack):
//   X-Timestamp: unix seconds
//   X-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
function verifyRequest({ secret, timestamp, signature, rawBody, nowSec, toleranceSec }) {
  if (!timestamp || !signature || rawBody == null) return { ok: false, reason: 'missing_headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowSec - ts) > (toleranceSec || TOLERANCE_SEC)) return { ok: false, reason: 'stale_timestamp' };
  const body = typeof rawBody === 'string' ? utf8(rawBody) : Array.from(rawBody);
  const expected = 'sha256=' + hmacSha256Hex(secret, utf8(String(timestamp) + '.').concat(body));
  return safeEqual(expected, String(signature)) ? { ok: true } : { ok: false, reason: 'invalid_signature' };
}

// Approval links carry a signed, expiring, action-scoped token: id.action.exp.sig
function signToken(secret, ticketId, action, expSec) {
  const base = ticketId + '.' + action + '.' + expSec;
  return base + '.' + hmacSha256Hex(secret, utf8(base)).slice(0, 32);
}

function verifyToken(secret, token, nowSec) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed_token' };
  const [id, action, exp, sig] = parts;
  const expected = hmacSha256Hex(secret, utf8(id + '.' + action + '.' + exp)).slice(0, 32);
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'invalid_token' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || (action !== 'approve' && action !== 'reject')) {
    return { ok: false, reason: 'malformed_token' };
  }
  if (!(Number(exp) > nowSec)) return { ok: false, reason: 'expired_token' };
  return { ok: true, ticketId: id, action };
}

// Returns a sanitized ticket. Any other fields (customer email, phone, ...) are dropped on purpose.
function validateTicket(t) {
  if (!t || typeof t !== 'object') return { ok: false, reason: 'invalid_payload' };
  if (typeof t.ticket_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.ticket_id)) return { ok: false, reason: 'invalid_ticket_id' };
  if (typeof t.subject !== 'string' || t.subject.length > 300) return { ok: false, reason: 'invalid_subject' };
  if (typeof t.body !== 'string' || t.body.length < 1 || t.body.length > 20000) return { ok: false, reason: 'invalid_body' };
  return { ok: true, ticket: { ticket_id: t.ticket_id, subject: t.subject, body: t.body } };
}

// --- exports (dropped when inlined into n8n) ---
module.exports = { verifyRequest, signToken, verifyToken, validateTicket, TOLERANCE_SEC };
