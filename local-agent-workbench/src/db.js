const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// The app's own tables live in the "workbench" schema, separate from your data in "public".
function createPool(url, opts = {}) {
  const pool = new Pool({ connectionString: url, max: 10, options: opts.searchPath === false ? undefined : '-c search_path=workbench', ...opts.pool });
  // An idle connection dropped by a database restart must not crash the process; the pool replaces it.
  pool.on('error', (e) => { if (!opts.quiet) console.error('postgres: idle connection error: ' + e.message); });
  return pool;
}

async function migrate(pool) {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // concurrent migrators queue up instead of racing
    await client.query('CREATE SCHEMA IF NOT EXISTS workbench');
    await client.query('CREATE TABLE IF NOT EXISTS workbench.schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query('SELECT name FROM workbench.schema_migrations')).rows.map((r) => r.name));
    const ran = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO workbench.schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        ran.push(f);
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

module.exports = { createPool, migrate };
