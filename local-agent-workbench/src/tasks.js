const fs = require('fs');
const path = require('path');
const { registry } = require('./tools');
const { parseCron } = require('./cron');
const audit = require('./audit');

// Task file format: header lines between --- markers, then the goal in plain English.
//   ---
//   name: organize-downloads
//   tools: fs.list, fs.move
//   schedule: 0 2 * * *
//   folders: ~/Downloads
//   ---
//   Sort the files in Downloads into folders by type...
function parseTaskFile(text, filename = 'task') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trim() + '\n');
  if (!m) throw new Error(filename + ': missing --- header block');
  const h = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error(filename + ': bad header line "' + line + '"');
    h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const task = {
    name: h.name, goal: m[2].trim(), tools: list(h.tools), schedule: h.schedule || null,
    folders: list(h.folders), domains: list(h.domains).map((d) => d.toLowerCase()),
    max_steps: h.max_steps ? Number(h.max_steps) : 12, on_untrusted_write: h.on_untrusted_write || 'approve',
  };
  if (!task.name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(task.name)) throw new Error(filename + ': name must be lowercase letters, digits and dashes');
  if (!task.goal) throw new Error(filename + ': goal is empty');
  if (!task.tools.length) throw new Error(filename + ': tools list is empty');
  for (const t of task.tools) if (!registry[t]) throw new Error(filename + ': unknown tool "' + t + '"');
  if (task.tools.includes('web.fetch') && !task.domains.length) throw new Error(filename + ': web.fetch needs a domains allowlist');
  if (task.tools.some((t) => t.startsWith('fs.')) && !task.folders.length) throw new Error(filename + ': fs tools need a folders list');
  if (!Number.isInteger(task.max_steps) || task.max_steps < 1 || task.max_steps > 50) throw new Error(filename + ': max_steps must be 1-50');
  if (!['approve', 'block'].includes(task.on_untrusted_write)) throw new Error(filename + ': on_untrusted_write must be approve or block');
  if (task.schedule) parseCron(task.schedule);
  return task;
}

async function syncTasks(pool, dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  const synced = [];
  for (const f of files) {
    const t = parseTaskFile(fs.readFileSync(path.join(dir, f), 'utf8'), f);
    await pool.query(
      `INSERT INTO tasks (name, goal, tools, schedule, folders, domains, max_steps, on_untrusted_write)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE SET goal=$2, tools=$3, schedule=$4, folders=$5, domains=$6, max_steps=$7, on_untrusted_write=$8, updated_at=now()`,
      [t.name, t.goal, t.tools, t.schedule, t.folders, t.domains, t.max_steps, t.on_untrusted_write]);
    await audit.append(pool, { actor: 'cli', event: 'task.synced', detail: { name: t.name, tools: t.tools, schedule: t.schedule, folders: t.folders, domains: t.domains } });
    synced.push(t.name);
  }
  return synced;
}

module.exports = { parseTaskFile, syncTasks };
