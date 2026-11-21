'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startApi, closeAll } = require('./helpers');
test.afterEach(closeAll);
const { HttpBackend, ApiError } = require('../src/backend');

test('auth: a wrong token is rejected and the error never contains the token', async () => {
  const { srv } = await startApi();
  const b = new HttpBackend({ baseUrl: srv.url, token: 'super-secret-wrong', sleep: async () => {} });
  await assert.rejects(b.get('T-1001'), (e) => e instanceof ApiError && e.status === 401 && !JSON.stringify(e).includes('super-secret') && !e.message.includes('super-secret'));
  await srv.close();
});

test('search: filters, text match, newest-first ordering and offset pagination', async () => {
  const { backend, srv } = await startApi();
  const urgent = await backend.search({ priority: 'urgent' });
  assert.deepStrictEqual(urgent.items.map((t) => t.id).sort(), ['T-1001', 'T-1009']);
  assert.strictEqual((await backend.search({ query: 'csv accented' })).total, 1);
  assert.strictEqual((await backend.search({ assignee: 'unassigned', status: 'open' })).items.every((t) => !t.assignee), true);
  const p1 = await backend.search({ limit: 5, offset: 0 }), p2 = await backend.search({ limit: 5, offset: 5 });
  assert.strictEqual(p1.total, 12);
  assert.strictEqual(new Set([...p1.items, ...p2.items].map((t) => t.id)).size, 10, 'pages do not overlap');
  assert.ok(p1.items[0].updated_at >= p1.items[4].updated_at);
  await srv.close();
});

test('create is idempotent: the same key twice makes one ticket', async () => {
  const { backend, api, srv } = await startApi();
  const before = api.state.tickets.length;
  const a = await backend.create({ title: 'Idempotent', priority: 'low' }, 'key-1');
  const b = await backend.create({ title: 'Idempotent', priority: 'low' }, 'key-1');
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(api.state.tickets.length, before + 1);
  await srv.close();
});

test('status changes follow the state machine; conflicts carry the allowed options', async () => {
  const { backend, srv } = await startApi();
  await assert.rejects(backend.setStatus('T-1012', 'in_progress'), (e) => e.status === 409 && e.details.allowed.includes('open'));
  assert.strictEqual((await backend.setStatus('T-1002', 'in_progress')).status, 'in_progress');
  await assert.rejects(backend.get('T-9999'), (e) => e.status === 404);
  await srv.close();
});

test('retries: transient 503s on reads are retried; writes that would duplicate are not', async () => {
  const { backend, api, srv } = await startApi();
  api.failNext(2, 503);
  assert.strictEqual((await backend.get('T-1001')).id, 'T-1001');
  api.failNext(1, 503);
  const before = api.state.tickets[0].comments.length;
  await assert.rejects(backend.comment('T-1001', 'hello', 'x'), (e) => e.status === 503);
  assert.strictEqual(api.state.tickets[0].comments.length, before, 'failed comment is not silently repeated');
  api.failNext(1, 503);
  assert.ok((await backend.create({ title: 'Retry-safe' }, 'k-retry')).id, 'create IS retried because of its idempotency key');
  await srv.close();
});

test('retries are bounded, honour Retry-After, and do not hammer a dead API', async () => {
  const { api, srv } = await startApi();
  const sleeps = [];
  const b = new HttpBackend({ baseUrl: srv.url, token: srv.token, retries: 2, sleep: async (ms) => sleeps.push(ms) });
  api.failNext(10, 429, { retryAfter: 1 });
  await assert.rejects(b.get('T-1001'), (e) => e.status === 429);
  assert.strictEqual(api.state.requests.length, 3, '1 try + 2 retries');
  assert.deepStrictEqual(sleeps, [1000, 1000]);
  await srv.close();
});

test('timeouts and unreachable hosts become typed errors', async () => {
  const slow = async (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  const b = new HttpBackend({ baseUrl: 'http://127.0.0.1:1', token: 't', timeoutMs: 20, retries: 0, fetchImpl: slow, sleep: async () => {} });
  await assert.rejects(b.get('T-1001'), (e) => e.code === 'timeout');
  const down = new HttpBackend({ baseUrl: 'http://127.0.0.1:1', token: 't', retries: 0, sleep: async () => {} });
  await assert.rejects(down.get('T-1001'), (e) => e.code === 'network');
});
