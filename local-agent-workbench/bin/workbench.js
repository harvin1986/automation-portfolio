#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (no dependency). Real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env */ }

const { createPool, migrate } = require('../src/db');
const { createAgent } = require('../src/agent');
const { createModel } = require('../src/model');
const { syncTasks } = require('../src/tasks');
const { tick } = require('../src/scheduler');
const { createWeb } = require('../src/web');
const audit = require('../src/audit');

const usage = `workbench <command>
  migrate               create/upgrade the workbench schema in your Postgres database
  sync [dir]            load task files (default ./tasks) into the database
  run <task>            queue a task now and process the queue once
  approvals             list actions waiting for approval
  verify                check the audit log hash chain
  start                 run the scheduler, worker and local approval console`;

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === 'help') return console.log(usage);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');
  const pool = createPool(process.env.DATABASE_URL);
  const dataPool = process.env.DATA_DATABASE_URL ? createPool(process.env.DATA_DATABASE_URL, { searchPath: false }) : null;
  const roots = (process.env.WORKBENCH_ROOTS || '').split(path.delimiter).filter(Boolean);
  const agent = createAgent({ pool, dataPool, globalRoots: roots, model: createModel({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.WORKBENCH_MODEL || 'claude-sonnet-5-5' }) });
  try {
    if (cmd === 'migrate') { const ran = await migrate(pool); console.log(ran.length ? 'applied: ' + ran.join(', ') : 'schema is up to date'); }
    else if (cmd === 'sync') { console.log('synced: ' + (await syncTasks(pool, arg || path.join(process.cwd(), 'tasks'))).join(', ')); }
    else if (cmd === 'run') {
      if (!arg) throw new Error('usage: workbench run <task>');
      if (!roots.length) console.warn('WORKBENCH_ROOTS is empty: file tools will be denied.');
      await agent.enqueue(arg, 'manual');
      while (await agent.runNext()) { /* drain */ }
      const r = (await pool.query('SELECT r.status, r.result, r.error FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.name = $1 ORDER BY r.created_at DESC LIMIT 1', [arg])).rows[0];
      console.log(r.status + (r.result ? '\n' + r.result : '') + (r.error ? '\nerror: ' + r.error : ''));
      if (r.status === 'waiting_approval') console.log('Waiting for approval. Run "workbench start" and open the console, or "workbench approvals".');
    }
    else if (cmd === 'approvals') {
      const rows = (await pool.query("SELECT a.id, a.tool, a.input, a.tainted FROM approvals a WHERE a.status = 'pending' ORDER BY a.created_at")).rows;
      console.log(rows.length ? rows.map((r) => r.id + '  ' + r.tool + (r.tainted ? '  [after untrusted content]' : '') + '\n  ' + JSON.stringify(r.input)).join('\n') : 'nothing waiting');
    }
    else if (cmd === 'verify') { const v = await audit.verify(pool); console.log(v.ok ? 'audit log intact (' + v.entries + ' entries)' : 'AUDIT LOG BROKEN at entry ' + v.brokenAt); process.exitCode = v.ok ? 0 : 2; }
    else if (cmd === 'start') {
      if (!roots.length) console.warn('WORKBENCH_ROOTS is empty: file tools will be denied.');
      const token = process.env.WORKBENCH_UI_TOKEN || crypto.randomBytes(24).toString('hex');
      const web = await createWeb({ pool, agent, token, port: Number(process.env.WORKBENCH_PORT || 8787) });
      console.log('Approval console: ' + web.url);
      let stop = false;
      process.on('SIGINT', () => { stop = true; });
      while (!stop) {
        try { await tick(pool, agent); await agent.expireApprovals(); await agent.recoverStuck(); while (!stop && await agent.runNext()) { /* drain */ } }
        catch (e) { console.error('loop error:', e.message); }
        await new Promise((r) => setTimeout(r, 5000));
      }
      await web.close();
    } else console.log(usage);
  } finally { await pool.end(); if (dataPool) await dataPool.end(); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
