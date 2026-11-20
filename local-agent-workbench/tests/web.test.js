const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const audit = require('../src/audit');
const { createWeb } = require('../src/web');

let env, web, agent, cookie, csrf;
const TOKEN = 'test-token-abcdef0123456789';

function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: web.port, method, path: url, headers: { host: '127.0.0.1:' + web.port, ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const authed = (extra = {}) => ({ cookie, ...extra });
const form = (o) => new URLSearchParams(o).toString();

test.before(async () => {
  if (H.skip) return;
  env = await H.createEnv();
  const src = path.join(env.sandbox, 'evil<img src=x onerror=alert(1)>.txt'); fs.writeFileSync(src, 'x');
  await H.addTask(env.pool, `name: webtask\ntools: fs.move\nfolders: ${env.sandbox}`);
  const model = H.scripted([H.calls(H.use('fs.move', { from: src, to: path.join(env.sandbox, 'moved.txt') })), H.say('done <img src=x onerror=alert(1)>')]);
  agent = H.makeAgent(env, model);
  await H.runTask(agent, 'webtask');
  web = await createWeb({ pool: env.pool, agent, token: TOKEN });
  const login = await req('GET', '/?token=' + TOKEN);
  cookie = login.headers['set-cookie'][0].split(';')[0];
  csrf = /name="csrf" value="([0-9a-f]+)"/.exec((await req('GET', '/', { headers: { cookie } })).body)[1];
});
test.after(async () => { if (web) await web.close(); if (env) await env.cleanup(); });
const t = (name, fn) => test(name, { skip: H.skip }, fn);

t('access control: no cookie, wrong token, and spoofed Host headers are all refused', async () => {
  assert.strictEqual((await req('GET', '/')).status, 401);
  assert.strictEqual((await req('GET', '/?token=wrong')).status, 401);
  assert.strictEqual((await req('GET', '/', { headers: { cookie, host: 'evil.example.com' } })).status, 403, 'DNS rebinding defense');
  assert.strictEqual((await req('GET', '/audit', { headers: { cookie: 'wb_session=nope' } })).status, 401);
  const ok = await req('GET', '/', { headers: { cookie } });
  assert.strictEqual(ok.status, 200);
  assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
  assert.strictEqual(ok.headers['x-frame-options'], 'DENY');
  assert.match((await req('GET', '/?token=' + TOKEN)).headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
});

t('XSS: names, inputs and results that came from files or models are escaped everywhere', async () => {
  const dash = (await req('GET', '/', { headers: { cookie } })).body;
  assert.ok(!dash.includes('<img src=x onerror'));
  assert.ok(dash.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const runId = (await env.pool.query('SELECT id FROM runs LIMIT 1')).rows[0].id;
  await env.pool.query('UPDATE runs SET result = $2, error = $2 WHERE id = $1', [runId, 'done <img src=x onerror=alert(1)>']);
  const runPage = (await req('GET', '/runs/' + runId, { headers: { cookie } })).body;
  assert.ok(!/<img src=x/.test(runPage));
  assert.ok(runPage.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.strictEqual((await req('GET', '/runs/not-a-uuid', { headers: { cookie } })).status, 404);
  assert.strictEqual((await req('GET', '/runs/' + encodeURIComponent("'; drop table runs;--"), { headers: { cookie } })).status, 404);
});

t('approving needs a valid CSRF token and a same-origin request', async () => {
  const apId = (await env.pool.query("SELECT id FROM approvals WHERE status = 'pending'")).rows[0].id;
  const post = (body, headers = {}) => req('POST', '/approvals/' + apId + '/decide', { headers: authed({ 'content-type': 'application/x-www-form-urlencoded', ...headers }), body });
  assert.strictEqual((await post(form({ decision: 'approve' }))).status, 403, 'missing csrf');
  assert.strictEqual((await post(form({ decision: 'approve', csrf: 'bad' }))).status, 403, 'wrong csrf');
  assert.strictEqual((await post(form({ decision: 'approve', csrf }), { origin: 'http://evil.example.com' })).status, 403, 'cross-site origin');
  assert.strictEqual((await req('POST', '/approvals/' + apId + '/decide', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ decision: 'approve', csrf }) })).status, 401, 'no session');
  assert.strictEqual((await env.pool.query('SELECT status FROM approvals WHERE id = $1', [apId])).rows[0].status, 'pending');
  const ok = await post(form({ decision: 'reject', csrf }), { origin: 'http://127.0.0.1:' + web.port });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual((await env.pool.query('SELECT status, decided_by FROM approvals WHERE id = $1', [apId])).rows[0].status, 'rejected');
  assert.strictEqual((await post(form({ decision: 'approve', csrf }))).status, 409, 'cannot decide twice');
});

t('the audit page reports the hash chain as intact, and says so loudly when it is not', async () => {
  assert.match((await req('GET', '/audit', { headers: { cookie } })).body, /intact/);
  await env.pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_no_update_delete');
  await env.pool.query("UPDATE audit_log SET actor = 'attacker' WHERE id = (SELECT min(id) FROM audit_log)");
  await env.pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_no_update_delete');
  assert.match((await req('GET', '/audit', { headers: { cookie } })).body, /BROKEN at entry/);
});
