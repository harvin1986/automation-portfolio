const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { hmacSha256Hex, sha256, toHex, utf8 } = require('../src/hmac');
const { verifyRequest, signToken, verifyToken, validateTicket } = require('../src/security');
const { redactPII } = require('../src/redact');
const breaker = require('../src/breaker');

test('sha256 and HMAC match Node crypto', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 20000]) {
    const m = Buffer.alloc(n, 7);
    assert.strictEqual(toHex(sha256(m)), crypto.createHash('sha256').update(m).digest('hex'));
  }
  for (const key of ['k', 'x'.repeat(100), 'ключ']) {
    const msg = 'héllo 😀 world';
    assert.strictEqual(hmacSha256Hex(key, utf8(msg)), crypto.createHmac('sha256', key).update(msg).digest('hex'));
  }
});

const NOW = 1_800_000_000;
const sign = (secret, ts, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');

test('verifyRequest accepts a valid signature', () => {
  const body = '{"a":1}';
  assert.deepStrictEqual(verifyRequest({ secret: 's', timestamp: String(NOW), signature: sign('s', NOW, body), rawBody: Buffer.from(body), nowSec: NOW }), { ok: true });
});

test('verifyRequest rejects wrong secret, tampered body, stale timestamp, missing parts', () => {
  const body = '{"a":1}';
  const base = { secret: 's', timestamp: String(NOW), signature: sign('s', NOW, body), rawBody: Buffer.from(body), nowSec: NOW };
  assert.strictEqual(verifyRequest({ ...base, secret: 'other' }).reason, 'invalid_signature');
  assert.strictEqual(verifyRequest({ ...base, rawBody: Buffer.from('{"a":2}') }).reason, 'invalid_signature');
  assert.strictEqual(verifyRequest({ ...base, nowSec: NOW + 301 }).reason, 'stale_timestamp');
  assert.strictEqual(verifyRequest({ ...base, nowSec: NOW - 301 }).reason, 'stale_timestamp');
  assert.strictEqual(verifyRequest({ ...base, signature: undefined }).reason, 'missing_headers');
  assert.strictEqual(verifyRequest({ ...base, timestamp: 'abc' }).reason, 'invalid_timestamp');
});

test('tokens: round trip, tamper, expiry, action scope', () => {
  const t = signToken('s', 'T-1', 'approve', NOW + 100);
  assert.deepStrictEqual(verifyToken('s', t, NOW), { ok: true, ticketId: 'T-1', action: 'approve' });
  assert.strictEqual(verifyToken('s', t, NOW + 200).reason, 'expired_token');
  assert.strictEqual(verifyToken('other', t, NOW).reason, 'invalid_token');
  assert.strictEqual(verifyToken('s', t.replace('.approve.', '.reject.'), NOW).reason, 'invalid_token');
  assert.strictEqual(verifyToken('s', t.replace('T-1', 'T-2'), NOW).reason, 'invalid_token');
  assert.strictEqual(verifyToken('s', 'junk', NOW).reason, 'malformed_token');
  assert.strictEqual(verifyToken('s', undefined, NOW).reason, 'malformed_token');
});

test('validateTicket sanitizes and drops extra fields', () => {
  const r = validateTicket({ ticket_id: 'A-1', subject: 'Hi', body: 'Text', customer_email: 'x@y.com' });
  assert.deepStrictEqual(r, { ok: true, ticket: { ticket_id: 'A-1', subject: 'Hi', body: 'Text' } });
  assert.strictEqual(validateTicket({ ticket_id: '../etc', subject: 's', body: 'b' }).reason, 'invalid_ticket_id');
  assert.strictEqual(validateTicket({ ticket_id: 'A', subject: 's', body: '' }).reason, 'invalid_body');
  assert.strictEqual(validateTicket(null).reason, 'invalid_payload');
});

test('redactPII removes identifiers and keeps normal text', () => {
  const r = redactPII('Email jane.doe@example.com or call (410) 555-0142. SSN 123-45-6789. Card 4111 1111 1111 1111. MRN: 88231. Order 12345678901234 is late.');
  assert.ok(!/jane|555-0142|123-45|4111|88231/.test(r.text), r.text);
  assert.ok(r.text.includes('[EMAIL]') && r.text.includes('[PHONE]') && r.text.includes('[SSN]') && r.text.includes('[CARD]') && r.text.includes('[ID]'));
  assert.ok(r.text.includes('12345678901234'), 'non-Luhn number must be left alone');
  assert.strictEqual(r.counts.email, 1);
});

test('circuit breaker opens after 3 failures and closes on success', () => {
  const s = { failures: 0, openUntil: 0 };
  breaker.recordFailure(s, 1000); breaker.recordFailure(s, 1000);
  assert.strictEqual(breaker.isOpen(s, 1000), false);
  breaker.recordFailure(s, 1000);
  assert.strictEqual(breaker.isOpen(s, 1001), true);
  assert.strictEqual(breaker.isOpen(s, 1000 + breaker.COOLDOWN_MS + 1), false);
  breaker.recordSuccess(s);
  assert.deepStrictEqual(s, { failures: 0, openUntil: 0 });
});
