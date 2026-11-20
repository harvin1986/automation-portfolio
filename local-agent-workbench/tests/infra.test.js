const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const audit = require('../src/audit');
const { migrate } = require('../src/db');
const { tick } = require('../src/scheduler');

let env;
test.before(async () => { if (!H.skip) env = await H.createEnv(); });
test.beforeEach(async () => { if (env) await env.pool.query("UPDATE runs SET status = 'failed' WHERE status IN ('queued', 'running', 'waiting_approval')"); });
test.after(async () => { if (env) await env.cleanup(); });
const t = (name, fn) => test(name, { skip: H.skip }, fn);
const noModel = async () => { throw new Error('model should not be called'); };

t('migrations are idempotent and safe to run concurrently', async () => {
  assert.deepStrictEqual(await migrate(env.pool), []);
  const results = await Promise.all([migrate(env.pool), migrate(env.pool), migrate(env.pool)]);
  assert.deepStrictEqual(results, [[], [], []]);
});

t('audit log: concurrent writers never fork the chain', async () => {
  await Promise.all(Array.from({ length: 25 }, (_, i) => audit.append(env.pool, { actor: 'test', event: 'e' + i, detail: { i } })));
  const v = await audit.verify(env.pool);
  assert.strictEqual(v.ok, true);
  assert.ok(v.entries >= 25);
});

t('audit log: UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
  for (const sql of ["UPDATE audit_log SET event = 'x'", 'DELETE FROM audit_log', 'TRUNCATE audit_log']) {
    await assert.rejects(env.pool.query(sql), /append-only/, sql);
  }
});

t('audit log: tampering by someone with full database access is detected and located', async () => {
  await audit.append(env.pool, { actor: 'test', event: 'before', detail: { n: 1 } });
  await audit.append(env.pool, { actor: 'test', event: 'victim', detail: { amount: 5 } });
  await audit.append(env.pool, { actor: 'test', event: 'after', detail: { n: 3 } });
  const { rows } = await env.pool.query("SELECT id FROM audit_log WHERE event = 'victim'");
  await env.pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_no_update_delete');
  await env.pool.query("UPDATE audit_log SET detail = '{\"amount\": 5000}' WHERE id = $1", [rows[0].id]);
  await env.pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_no_update_delete');
  const v = await audit.verify(env.pool);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, Number(rows[0].id));
  // restore so later tests see a valid chain
  await env.pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_no_update_delete');
  await env.pool.query("UPDATE audit_log SET detail = '{\"amount\": 5}' WHERE id = $1", [rows[0].id]);
  await env.pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_no_update_delete');
  assert.strictEqual((await audit.verify(env.pool)).ok, true);
});

t('scheduler: a due slot is enqueued exactly once, even with concurrent schedulers', async () => {
  await H.addTask(env.pool, 'name: nightly\ntools: note.save\nschedule: 0 2 * * *');
  await env.pool.query("UPDATE tasks SET created_at = '2026-11-18T12:00:00Z' WHERE name = 'nightly'");
  const agent = H.makeAgent(env, noModel);
  const now = new Date(2026, 10, 19, 3, 0); // 03:00 local, after the 02:00 slot
  const created = (await Promise.all([tick(env.pool, agent, now), tick(env.pool, agent, now), tick(env.pool, agent, now)])).flat();
  assert.strictEqual(created.length, 1);
  assert.strictEqual((await tick(env.pool, agent, now)).length, 0, 'same slot is not enqueued again');
  const r = (await env.pool.query("SELECT trigger, scheduled_for FROM runs WHERE id = $1", [created[0]])).rows[0];
  assert.strictEqual(r.trigger, 'schedule');
  assert.strictEqual(r.scheduled_for.getTime(), new Date(2026, 10, 19, 2, 0).getTime());
});

t('scheduler: after a long outage it enqueues one catch-up run, not one per missed slot', async () => {
  await H.addTask(env.pool, 'name: hourly\ntools: note.save\nschedule: 0 * * * *');
  await env.pool.query("UPDATE tasks SET created_at = '2026-11-01T00:00:00Z' WHERE name = 'hourly'");
  const agent = H.makeAgent(env, noModel);
  const ids = await tick(env.pool, agent, new Date(2026, 10, 10, 12, 30));
  assert.strictEqual(ids.length, 1);
  const skipped = await env.pool.query("SELECT detail FROM audit_log WHERE event = 'scheduler.skipped_missed' AND run_id = $1", [ids[0]]);
  assert.ok(skipped.rows[0].detail.skipped > 100);
});

t('scheduler: disabled and unscheduled tasks never run', async () => {
  await H.addTask(env.pool, 'name: off\ntools: note.save\nschedule: * * * * *');
  await H.addTask(env.pool, 'name: manual-only\ntools: note.save');
  await env.pool.query("UPDATE tasks SET enabled = false, created_at = '2026-11-01T00:00:00Z' WHERE name = 'off'");
  const before = (await env.pool.query("SELECT count(*) FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.name IN ('off','manual-only')")).rows[0].count;
  await tick(env.pool, H.makeAgent(env, noModel), new Date(2026, 10, 19, 12, 0));
  assert.strictEqual((await env.pool.query("SELECT count(*) FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.name IN ('off','manual-only')")).rows[0].count, before);
  await assert.rejects(H.makeAgent(env, noModel).enqueue('off'), /disabled/);
});

t('workers: concurrent workers never run the same task twice at once, and never take the same run', async () => {
  await H.addTask(env.pool, 'name: busy\ntools: note.save');
  await H.addTask(env.pool, 'name: other\ntools: note.save');
  const a = H.makeAgent(env, noModel, { workerId: 'A' }), b = H.makeAgent(env, noModel, { workerId: 'B' });
  const r1 = await a.enqueue('busy'), r2 = await a.enqueue('busy');
  const claimed = (await Promise.all([a.claimNext(), b.claimNext()])).filter(Boolean);
  assert.strictEqual(claimed.length, 1, 'second run of the same task must wait');
  assert.ok([r1, r2].includes(claimed[0].id));
  await env.pool.query("UPDATE runs SET status = 'failed' WHERE status = 'running'");
  await env.pool.query("UPDATE runs SET status = 'failed' WHERE status = 'queued'");
  const o1 = await a.enqueue('busy'), o2 = await a.enqueue('other');
  const two = (await Promise.all([a.claimNext(), b.claimNext()])).filter(Boolean);
  assert.deepStrictEqual(two.map((r) => r.id).sort(), [o1, o2].sort());
});

t('recovery: a run stuck in "running" after a crash goes back to the queue', async () => {
  await H.addTask(env.pool, 'name: crashy\ntools: note.save');
  const agent = H.makeAgent(env, noModel);
  const id = await agent.enqueue('crashy');
  await agent.claimNext();
  assert.strictEqual(await agent.recoverStuck(30), 0, 'recent runs are left alone');
  await env.pool.query("UPDATE runs SET started_at = now() - interval '2 hours' WHERE id = $1", [id]);
  assert.strictEqual(await agent.recoverStuck(30), 1);
  assert.strictEqual((await H.getRun(env.pool, id)).status, 'queued');
});
