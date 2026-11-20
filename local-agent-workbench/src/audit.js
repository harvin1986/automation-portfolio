const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

// Keys sorted recursively so the hash is stable across jsonb round trips.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Removes secrets before anything is written to the log or the database.
function redact(value, secrets = []) {
  const list = [process.env.ANTHROPIC_API_KEY, ...secrets].filter((s) => s && s.length >= 8);
  const clean = (s) => {
    let t = String(s).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]').replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, '$1[REDACTED]@');
    for (const x of list) t = t.split(x).join('[REDACTED]');
    return t;
  };
  const walk = (v) => {
    if (typeof v === 'string') return clean(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

// Appends one entry. A transaction-level advisory lock serializes writers so the chain never forks.
async function append(pool, { actor, event, runId = null, detail = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727002)');
    const last = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = last.rows[0] ? last.rows[0].hash : GENESIS;
    const at = new Date();
    const safe = redact(detail);
    const hash = sha(prev + canonical({ at: at.toISOString(), actor, event, run_id: runId, detail: safe }));
    await client.query('INSERT INTO audit_log (at, actor, event, run_id, detail, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)', [at, actor, event, runId, JSON.stringify(safe), prev, hash]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// Recomputes the whole chain. Returns { ok: true, entries } or { ok: false, brokenAt }.
async function verify(pool) {
  const { rows } = await pool.query('SELECT id, at, actor, event, run_id, detail, prev_hash, hash FROM audit_log ORDER BY id');
  let prev = GENESIS;
  for (const r of rows) {
    const expected = sha(prev + canonical({ at: r.at.toISOString(), actor: r.actor, event: r.event, run_id: r.run_id, detail: r.detail }));
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, brokenAt: Number(r.id), entries: rows.length };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}

module.exports = { append, verify, redact, canonical, sha, GENESIS };
