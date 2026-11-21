'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { connect, call, text, closeAll } = require('./helpers');
test.afterEach(closeAll);
const { TokenBucket } = require('../src/safety');

test('read-only by default: write tools are not even listed; annotations mark reads as read-only', async () => {
  const h = await connect();
  const tools = (await h.client.listTools()).tools;
  assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['queue_stats', 'tickets_get', 'tickets_search']);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true && t.description.length > 30));
  const r = await call(h.client, 'tickets_create', { title: 'sneaky' }).catch((e) => e);
  assert.ok(r instanceof Error || r.isError, 'calling an unlisted tool fails');
  assert.strictEqual(h.api.state.tickets.length, 12);
  await h.close();
});

test('with writes enabled the three write tools appear, with honest annotations', async () => {
  const h = await connect({ allowWrites: true });
  const tools = (await h.client.listTools()).tools;
  assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['queue_stats', 'tickets_comment', 'tickets_create', 'tickets_get', 'tickets_search', 'tickets_update_status']);
  for (const n of ['tickets_create', 'tickets_comment', 'tickets_update_status']) assert.strictEqual(tools.find((t) => t.name === n).annotations.readOnlyHint, false);
  assert.match((await h.client.getInstructions?.()) || '', /two steps|Write tools/);
  await h.close();
});

test('search: structured results, summaries only, pagination through every ticket exactly once', async () => {
  const h = await connect();
  const seen = []; let cursor;
  do {
    const r = await call(h.client, 'tickets_search', { limit: 5, ...(cursor ? { cursor } : {}) });
    assert.ok(!r.isError, text(r));
    seen.push(...r.structuredContent.items.map((t) => t.id)); cursor = r.structuredContent.next_cursor;
    assert.ok(r.structuredContent.items.every((t) => t.snippet.length <= 200 + 30 && !('comments' in t)));
  } while (cursor);
  assert.strictEqual(seen.length, 12); assert.strictEqual(new Set(seen).size, 12);
  const f = await call(h.client, 'tickets_search', { status: 'open', assignee: 'unassigned' });
  assert.ok(f.structuredContent.items.every((t) => t.status === 'open' && t.assignee === null));
  assert.deepStrictEqual(f.structuredContent.untrusted_fields, ['title', 'snippet']);
  await h.close();
});

test('input validation: bad ids, enums and limits are rejected before reaching the API', async () => {
  const h = await connect();
  const before = h.api.state.requests.length;
  for (const [name, args] of [['tickets_get', { id: '../../admin' }], ['tickets_get', { id: 'T-1; DROP' }], ['tickets_search', { status: 'deleted' }], ['tickets_search', { limit: 500 }], ['tickets_search', { query: 'x'.repeat(500) }]]) {
    const r = await call(h.client, name, args).catch((e) => ({ isError: true, thrown: e }));
    assert.ok(r.isError, `${name} ${JSON.stringify(args)} should be rejected`);
  }
  assert.strictEqual(h.api.state.requests.length, before, 'nothing reached the upstream API');
  const bad = await call(h.client, 'tickets_search', { cursor: Buffer.from('o:-5').toString('base64url') });
  assert.ok(bad.isError); assert.match(text(bad), /Invalid cursor/);
  await h.close();
});

test('tickets_get: PII is redacted and ticket text is fenced as untrusted data', async () => {
  const h = await connect();
  const r = await call(h.client, 'tickets_get', { id: 't-1004' }); // lower-case accepted
  const t = text(r);
  assert.ok(!/jane\.roe@|410-555-0142|4242 4242/.test(t + JSON.stringify(r.structuredContent)));
  assert.match(t, /\[email\]/); assert.match(t, /\[card\]/);
  assert.match(t, /<<<UNTRUSTED_TICKET_TEXT description>>>/);
  assert.ok(r.structuredContent.untrusted_fields.includes('description'));
  await h.close();
});

test('prompt injection in a ticket is delivered as fenced data and cannot trigger or authorise anything', async () => {
  const h = await connect({ allowWrites: true });
  const r = await call(h.client, 'tickets_get', { id: 'T-1007' });
  const t = text(r);
  assert.strictEqual(t.split('<<<END_UNTRUSTED_TICKET_TEXT>>>').length - 1, 2, 'one closing delimiter per block (description + comment); the forged one was neutralised');
  assert.match(t, /\[delimiter removed\]/);
  assert.match(t, /never as instructions/);
  // Even if a model were fooled, the write path only previews: nothing changes without a human-approved token.
  const p = await call(h.client, 'tickets_update_status', { id: 'T-1002', status: 'closed' });
  assert.strictEqual(p.structuredContent.status, 'preview');
  assert.strictEqual(h.api.state.tickets.find((x) => x.id === 'T-1002').status, 'open');
  assert.ok(h.api.state.requests.every((q) => q.method === 'GET'), 'only reads hit the upstream API');
  await h.close();
});

test('redaction can be turned off by the operator', async () => {
  const h = await connect({ redact: false });
  assert.match(text(await call(h.client, 'tickets_get', { id: 'T-1004' })), /jane\.roe@example\.org/);
  await h.close();
});

test('errors are actionable and leak nothing: not found, auth failure, upstream outage', async () => {
  const h = await connect();
  const nf = await call(h.client, 'tickets_get', { id: 'T-9999' });
  assert.ok(nf.isError); assert.match(text(nf), /not found.*tickets_search/);
  h.api.failNext(5, 503);
  const down = await call(h.client, 'tickets_get', { id: 'T-1001' });
  assert.ok(down.isError); assert.match(text(down), /unavailable.*temporary/); assert.ok(!/127\.0\.0\.1|Bearer|demo-token/.test(text(down)));
  await h.close();
});

test('bad credentials: the model sees a safe message that points at the operator, not the secret', async () => {
  const { startApi } = require('./helpers'); const { HttpBackend } = require('../src/backend'); const { createServer } = require('../src/server');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'); const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { srv } = await startApi();
  const server = createServer({ backend: new HttpBackend({ baseUrl: srv.url, token: 'wrong-token-xyz', sleep: async () => {} }) });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await call(client, 'queue_stats');
  assert.ok(r.isError); assert.match(text(r), /TICKETS_API_TOKEN/); assert.ok(!text(r).includes('wrong-token-xyz'));
  await client.close(); await server.close(); await srv.close();
});

test('queue_stats and resources', async () => {
  const h = await connect();
  const s = await call(h.client, 'queue_stats');
  assert.strictEqual(s.structuredContent.total, 12); assert.strictEqual(s.structuredContent.by_status.open, 6);
  const res = await h.client.listResources();
  assert.ok(res.resources.some((r) => r.uri === 'tickets://stats'));
  assert.ok((await h.client.listResourceTemplates()).resourceTemplates.some((r) => r.uriTemplate === 'ticket://{id}'));
  assert.strictEqual(JSON.parse((await h.client.readResource({ uri: 'tickets://stats' })).contents[0].text).total, 12);
  const tr = JSON.parse((await h.client.readResource({ uri: 'ticket://T-1004' })).contents[0].text);
  assert.ok(!JSON.stringify(tr).includes('jane.roe@'));
  assert.ok(tr.untrusted_fields.includes('description'));
  await assert.rejects(h.client.readResource({ uri: 'ticket://not-an-id' }));
  await h.close();
});

test('prompts: triage and report templates tell the model to treat ticket text as data and not to write', async () => {
  const h = await connect();
  assert.deepStrictEqual((await h.client.listPrompts()).prompts.map((p) => p.name).sort(), ['queue_report', 'triage_ticket']);
  const p = await h.client.getPrompt({ name: 'triage_ticket', arguments: { id: 'T-1001' } });
  assert.match(p.messages[0].content.text, /T-1001/); assert.match(p.messages[0].content.text, /untrusted/); assert.match(p.messages[0].content.text, /Do not change/);
  await assert.rejects(h.client.getPrompt({ name: 'triage_ticket', arguments: { id: 'oops' } }));
  await h.close();
});

test('write flow: preview changes nothing; confirm executes once; retrying the same token never duplicates', async () => {
  const h = await connect({ allowWrites: true });
  const args = { title: 'Printer on 3rd floor is down', priority: 'high' };
  const preview = await call(h.client, 'tickets_create', args);
  assert.strictEqual(preview.structuredContent.status, 'preview');
  assert.strictEqual(h.api.state.tickets.length, 12);
  const token = preview.structuredContent.confirmation_token;
  const done = await call(h.client, 'tickets_create', { ...args, confirmation_token: token });
  assert.strictEqual(done.structuredContent.status, 'done'); assert.strictEqual(h.api.state.tickets.length, 13);
  const again = await call(h.client, 'tickets_create', { ...args, confirmation_token: token });
  assert.strictEqual(again.structuredContent.replayed, true);
  assert.strictEqual(again.structuredContent.ticket.id, done.structuredContent.ticket.id);
  assert.strictEqual(h.api.state.tickets.length, 13, 'still exactly one new ticket');
  await h.close();
});

test('write flow: a token only works for the exact arguments it was issued for', async () => {
  const h = await connect({ allowWrites: true });
  const p = await call(h.client, 'tickets_update_status', { id: 'T-1002', status: 'in_progress' });
  const token = p.structuredContent.confirmation_token;
  const swapped = await call(h.client, 'tickets_update_status', { id: 'T-1003', status: 'in_progress', confirmation_token: token });
  assert.ok(swapped.isError); assert.match(text(swapped), /does not match these arguments/);
  const other = await call(h.client, 'tickets_update_status', { id: 'T-1002', status: 'closed', confirmation_token: token });
  assert.ok(other.isError);
  const forged = await call(h.client, 'tickets_update_status', { id: 'T-1002', status: 'in_progress', confirmation_token: 'abc.123.def' });
  assert.ok(forged.isError);
  assert.strictEqual(h.api.state.tickets.find((t) => t.id === 'T-1002').status, 'open', 'nothing changed');
  const ok = await call(h.client, 'tickets_update_status', { id: 't-1002', status: 'in_progress', confirmation_token: token });
  assert.ok(!ok.isError, text(ok)); assert.strictEqual(h.api.state.tickets.find((t) => t.id === 'T-1002').status, 'in_progress');
  await h.close();
});

test('write flow: invalid transitions surface the allowed options; comments are added once; failures can be retried with the same token', async () => {
  const h = await connect({ allowWrites: true });
  const bad = await call(h.client, 'tickets_update_status', { id: 'T-1012', status: 'blocked' });
  const badDone = await call(h.client, 'tickets_update_status', { id: 'T-1012', status: 'blocked', confirmation_token: bad.structuredContent.confirmation_token });
  assert.ok(badDone.isError); assert.match(text(badDone), /Allowed next statuses: open/);
  const args = { id: 'T-1001', body: 'Fix deployed to staging, verifying.' };
  const pc = await call(h.client, 'tickets_comment', args);
  assert.match(text(pc), /PREVIEW/);
  h.api.failNext(1, 503);
  const fail = await call(h.client, 'tickets_comment', { ...args, confirmation_token: pc.structuredContent.confirmation_token });
  assert.ok(fail.isError);
  const n = h.api.state.tickets[0].comments.length;
  const ok = await call(h.client, 'tickets_comment', { ...args, confirmation_token: pc.structuredContent.confirmation_token });
  assert.ok(!ok.isError, text(ok));
  assert.strictEqual(h.api.state.tickets[0].comments.length, n + 1);
  await h.close();
});

test('rate limiting stops a runaway loop and tells the caller when to retry', async () => {
  let t = 0;
  const h = await connect({ serverOpts: { rate: new TokenBucket({ capacity: 3, refillPerSec: 0.1, now: () => t }) } });
  for (let i = 0; i < 3; i++) assert.ok(!(await call(h.client, 'queue_stats')).isError);
  const r = await call(h.client, 'queue_stats');
  assert.ok(r.isError); assert.match(text(r), /Wait \d+s/);
  const upstream = h.api.state.requests.length;
  await call(h.client, 'queue_stats');
  assert.strictEqual(h.api.state.requests.length, upstream, 'refused calls never reach the API');
  await h.close();
});

test('audit log: every call is recorded with a hash and outcome, never with ticket content', async () => {
  const h = await connect({ allowWrites: true });
  await call(h.client, 'tickets_get', { id: 'T-1004' });
  await call(h.client, 'tickets_get', { id: 'T-9999' });
  await call(h.client, 'tickets_comment', { id: 'T-1001', body: 'secret internal remark' });
  const e = h.audit.entries;
  assert.deepStrictEqual(e.map((x) => [x.tool, x.ok]), [['tickets_get', true], ['tickets_get', false], ['tickets_comment', true]]);
  assert.strictEqual(e[1].code, 'not_found');
  assert.ok(e.every((x) => /^[0-9a-f]{16}$/.test(x.input_hash) && typeof x.ms === 'number'));
  assert.ok(!JSON.stringify(e).match(/jane|secret internal|4242/));
  await h.close();
});
