const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCron, nextRun } = require('../src/cron');
const { parseTaskFile } = require('../src/tasks');
const { resolveInRoots } = require('../src/paths');
const { checkSelect, registry } = require('../src/tools');
const audit = require('../src/audit');
const { createModel } = require('../src/model');

test('cron: next run for common schedules', () => {
  assert.strictEqual(nextRun('0 2 * * *', new Date(2026, 10, 19, 23, 0)).getTime(), new Date(2026, 10, 20, 2, 0).getTime());
  assert.strictEqual(nextRun('*/15 9-17 * * 1-5', new Date(2026, 10, 20, 17, 50)).getTime(), new Date(2026, 10, 23, 9, 0).getTime()); // Fri evening -> Mon morning
  assert.strictEqual(nextRun('30 8 1 * *', new Date(2026, 10, 19)).getTime(), new Date(2026, 11, 1, 8, 30).getTime());
  assert.strictEqual(nextRun('0 0 * * 7', new Date(2026, 10, 19)).getDay(), 0); // 7 = Sunday
  assert.strictEqual(nextRun('* * * * *', new Date(2026, 10, 19, 10, 0, 30)).getTime(), new Date(2026, 10, 19, 10, 1).getTime());
});

test('cron: invalid expressions are rejected', () => {
  for (const bad of ['', '* * * *', '61 * * * *', '* 24 * * *', '*/0 * * * *', 'a b c d e', '5-2 * * * *']) assert.throws(() => parseCron(bad), bad);
});

test('task files: parsed and validated', () => {
  const t = parseTaskFile('---\nname: organize\ntools: fs.list, fs.move\nschedule: 0 2 * * *\nfolders: ~/Downloads\nmax_steps: 8\n---\nSort the files.', 'f');
  assert.deepStrictEqual([t.name, t.tools, t.schedule, t.max_steps, t.goal], ['organize', ['fs.list', 'fs.move'], '0 2 * * *', 8, 'Sort the files.']);
  const bad = (h) => assert.throws(() => parseTaskFile('---\n' + h + '\n---\ngoal', 'f'));
  bad('name: x\ntools: nope');
  bad('name: x\ntools: web.fetch');                    // needs a domains allowlist
  bad('name: x\ntools: fs.list');                      // needs folders
  bad('name: Bad Name\ntools: note.save');
  bad('name: x\ntools: note.save\nschedule: nonsense');
  bad('name: x\ntools: note.save\nmax_steps: 500');
  bad('name: x\ntools: note.save\non_untrusted_write: allow');
  assert.throws(() => parseTaskFile('no header', 'f'));
});

test('sandbox: traversal, absolute paths, symlinks and null bytes cannot escape the allowed folder', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-u-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  try {
    assert.strictEqual(resolveInRoots(path.join(root, 'sub'), [root]), path.join(root, 'sub'));
    assert.strictEqual(resolveInRoots(path.join(root, 'new', 'file.txt'), [root]), path.join(root, 'new', 'file.txt')); // not-yet-existing paths are fine
    for (const bad of [path.join(root, '..', 'x'), path.join(root, 'sub', '..', '..'), outside, '/etc/passwd', path.join(root, 'link', 'secret.txt'), path.join(root, 'link'), 'x\0y', '', undefined]) {
      assert.throws(() => resolveInRoots(bad, [root]), String(bad));
    }
    assert.throws(() => resolveInRoots(root, []), /no folders/);
    // a sibling folder with the same prefix is not "inside"
    const sib = root + '-evil'; fs.mkdirSync(sib);
    assert.throws(() => resolveInRoots(sib, [root]));
    fs.rmSync(sib, { recursive: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('db.query validation: one SELECT only, no escape hatches', () => {
  assert.strictEqual(checkSelect('select 1;'), 'select 1');
  assert.ok(checkSelect('WITH a AS (SELECT 1) SELECT * FROM a'));
  for (const bad of ['delete from customers', 'select 1; select 2', 'insert into x values (1)', 'select pg_read_file(\'/etc/passwd\')', 'select * from workbench.audit_log', 'select 1 /* ; */ ; drop table x', "select set_config('a','b',false)", 'copy x to stdout', 'update x set a=1']) {
    assert.throws(() => checkSelect(bad), bad);
  }
});

test('audit redaction removes API keys and database passwords', () => {
  const r = audit.redact({ a: 'key sk-ant-api03-ABCDEFGH12345678 here', b: ['postgres://user:hunter2@host/db'] });
  assert.ok(!/ABCDEFGH|hunter2/.test(JSON.stringify(r)));
  process.env.ANTHROPIC_API_KEY = 'custom-secret-value';
  assert.ok(!/custom-secret-value/.test(JSON.stringify(audit.redact({ x: 'token custom-secret-value end' }))));
  delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual(audit.canonical({ b: 1, a: { d: 2, c: [3] } }), '{"a":{"c":[3],"d":2},"b":1}');
});

test('web.fetch: https and domain allowlist, no IPs, redirects re-checked, size and type limits', async () => {
  const mk = (map) => async (url) => {
    const r = map[url]; if (!r) throw new Error('unexpected fetch ' + url);
    return { ok: r.status === undefined || r.status < 300, status: r.status || 200, headers: { get: (h) => ({ 'content-type': r.type || 'text/html', location: r.location }[h.toLowerCase()] || null) }, text: async () => r.body || '' };
  };
  const run = (ctx, url) => registry['web.fetch'].run({ domains: ['example.com'], ...ctx }, { url });
  const f = mk({
    'https://example.com/a': { body: '<html><script>evil()</script><p>Hello   world</p></html>' },
    'https://sub.example.com/b': { body: 'ok', type: 'text/plain' },
    'https://example.com/redir': { status: 302, location: 'https://evil.org/x' },
    'https://example.com/redir-ok': { status: 302, location: '/a' },
    'https://example.com/bin': { type: 'application/zip', body: 'x' },
    'https://example.com/big': { type: 'text/plain', body: 'a'.repeat(50000) },
  });
  assert.strictEqual(await run({ fetchImpl: f }, 'https://example.com/a'), 'Hello world');
  assert.strictEqual(await run({ fetchImpl: f }, 'https://sub.example.com/b'), 'ok');
  assert.strictEqual(await run({ fetchImpl: f }, 'https://example.com/redir-ok'), 'Hello world');
  await assert.rejects(run({ fetchImpl: f }, 'https://example.com/redir'), /allowlist/);
  await assert.rejects(run({ fetchImpl: f }, 'https://notexample.com/a'), /allowlist/);
  await assert.rejects(run({ fetchImpl: f }, 'https://example.com.evil.org/a'), /allowlist/);
  await assert.rejects(run({ fetchImpl: f }, 'http://example.com/a'), /https/);
  await assert.rejects(run({ fetchImpl: f }, 'https://127.0.0.1/a'), /IP/);
  await assert.rejects(run({ fetchImpl: f }, 'https://example.com/bin'), /content type/);
  assert.ok((await run({ fetchImpl: f }, 'https://example.com/big')).includes('[truncated]'));
});

test('model client retries 429/5xx with backoff, fails fast on 4xx, and reports the final error', async () => {
  const seq = (...codes) => { let i = 0; const waits = []; const f = async () => { const c = codes[i++]; return c === 200 ? { ok: true, status: 200, json: async () => ({ content: [] }) } : { ok: false, status: c, text: async () => 'err' }; }; f.waits = waits; return f; };
  const f1 = seq(529, 500, 200); const sleeps = [];
  const m1 = createModel({ apiKey: 'k', fetchImpl: f1, sleep: async (ms) => sleeps.push(ms) });
  assert.deepStrictEqual(await m1({ system: '', messages: [], tools: [] }), { content: [] });
  assert.deepStrictEqual(sleeps, [1000, 2000]);
  const m2 = createModel({ apiKey: 'k', fetchImpl: seq(400, 200), sleep: async () => {} });
  await assert.rejects(m2({ system: '', messages: [], tools: [] }), /400/);
  const m3 = createModel({ apiKey: 'k', fetchImpl: seq(500, 500, 500), sleep: async () => {} });
  await assert.rejects(m3({ system: '', messages: [], tools: [] }), /500/);
  await assert.rejects(createModel({ fetchImpl: seq(200) })({ system: '', messages: [], tools: [] }), /ANTHROPIC_API_KEY/);
});
