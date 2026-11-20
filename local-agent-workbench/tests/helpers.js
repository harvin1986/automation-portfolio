const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createPool, migrate } = require('../src/db');
const { createAgent } = require('../src/agent');
const { parseTaskFile } = require('../src/tasks');

const ADMIN_URL = process.env.TEST_ADMIN_URL;
const skip = ADMIN_URL ? false : 'set TEST_ADMIN_URL (a Postgres superuser URL) to run the database tests';

// A throwaway database per test file.
async function createEnv() {
  const name = 'wb_' + crypto.randomBytes(5).toString('hex');
  const admin = new Pool({ connectionString: ADMIN_URL }); admin.on('error', () => {});
  await admin.query('CREATE DATABASE ' + name);
  const url = new URL(ADMIN_URL); url.pathname = '/' + name;
  const pool = createPool(url.toString(), { quiet: true });
  const dataPool = createPool(url.toString(), { searchPath: false, quiet: true });
  await migrate(pool);
  await dataPool.query('CREATE TABLE public.customers (id int, name text)');
  await dataPool.query("INSERT INTO public.customers SELECT g, 'cust' || g FROM generate_series(1, 1000) g");
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sandbox-')));
  return {
    pool, dataPool, sandbox, name,
    async cleanup() { await pool.end(); await dataPool.end(); await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)'); await admin.end(); fs.rmSync(sandbox, { recursive: true, force: true }); },
  };
}

async function addTask(pool, header, goal = 'Do the thing.') {
  const t = parseTaskFile('---\n' + header.trim() + '\n---\n' + goal, 'test');
  await pool.query('INSERT INTO tasks (name, goal, tools, schedule, folders, domains, max_steps, on_untrusted_write) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (name) DO UPDATE SET goal=$2, tools=$3, schedule=$4, folders=$5, domains=$6, max_steps=$7, on_untrusted_write=$8',
    [t.name, t.goal, t.tools, t.schedule, t.folders, t.domains, t.max_steps, t.on_untrusted_write]);
  return t;
}

// A model that plays back a fixed script and records every request it receives.
function scripted(steps) {
  let i = 0;
  const fn = async (req) => {
    fn.calls.push(JSON.parse(JSON.stringify(req)));
    const s = steps[i++];
    if (!s) throw new Error('script exhausted');
    return typeof s === 'function' ? s(req) : s;
  };
  fn.calls = [];
  return fn;
}
const usage = { input_tokens: 100, output_tokens: 20 };
const use = (name, input, id) => ({ type: 'tool_use', id: id || 'tu_' + crypto.randomBytes(4).toString('hex'), name: name.replace('.', '__'), input });
const calls = (...blocks) => ({ content: blocks, usage, stop_reason: 'tool_use' });
const say = (text) => ({ content: [{ type: 'text', text }], usage, stop_reason: 'end_turn' });

function makeAgent(env, model, extra = {}) {
  return createAgent({ pool: env.pool, dataPool: env.dataPool, model, globalRoots: [env.sandbox], allowInsecureForTests: true, ...extra });
}

async function runTask(agent, name) {
  const id = await agent.enqueue(name, 'manual');
  await agent.runNext();
  return id;
}
const getRun = async (pool, id) => (await pool.query('SELECT * FROM runs WHERE id = $1', [id])).rows[0];
const lastToolResults = (model) => { const m = model.calls[model.calls.length - 1].messages; const last = m[m.length - 1]; return last.content; };

module.exports = { skip, createEnv, addTask, scripted, use, calls, say, makeAgent, runTask, getRun, lastToolResults, usage };
