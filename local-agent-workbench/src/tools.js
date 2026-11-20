const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { resolveInRoots, ToolError } = require('./paths');

// Tiers: "read" and "internal" run automatically. "write" always waits for a human to approve the exact input.
// "untrusted" tools return content from outside the system; reading it marks the run as tainted.

const MAX_OUT = 20000;
const clip = (s, n = MAX_OUT) => (String(s).length > n ? String(s).slice(0, n) + '\n[truncated]' : String(s));

const str = (v, name) => { if (typeof v !== 'string' || !v) throw new ToolError(name + ' must be a non-empty string'); return v; };

const registry = {
  'fs.list': {
    tier: 'read', untrusted: false,
    description: 'List files and folders in an allowed folder.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(ctx, input) {
      const dir = resolveInRoots(str(input.path, 'path'), ctx.roots);
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200).map((d) => {
        const st = fs.statSync(path.join(dir, d.name), { throwIfNoEntry: false });
        return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: st ? st.size : null, modified: st ? st.mtime.toISOString() : null };
      });
      return JSON.stringify(entries);
    },
  },
  'fs.read_text': {
    tier: 'read', untrusted: true,
    description: 'Read the beginning of a text file in an allowed folder (up to 20 KB).',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(ctx, input) {
      const file = resolveInRoots(str(input.path, 'path'), ctx.roots);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(MAX_OUT);
        const n = fs.readSync(fd, buf, 0, MAX_OUT, 0);
        if (buf.subarray(0, n).includes(0)) throw new ToolError('file looks binary; only text files can be read');
        return buf.subarray(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    },
  },
  'fs.move': {
    tier: 'write', untrusted: false,
    description: 'Move or rename a file inside the allowed folders. Never overwrites. Requires human approval.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    preflight(ctx, input) {
      const from = resolveInRoots(str(input.from, 'from'), ctx.roots);
      const to = resolveInRoots(str(input.to, 'to'), ctx.roots);
      if (!fs.existsSync(from)) throw new ToolError('source does not exist');
      if (fs.existsSync(to)) throw new ToolError('destination already exists; refusing to overwrite');
      return { from, to };
    },
    async run(ctx, input) {
      const { from, to } = this.preflight(ctx, input); // re-checked at execution time, never trusted from earlier
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return 'moved';
    },
  },
  'fs.write_text': {
    tier: 'write', untrusted: false,
    description: 'Create a new text file inside the allowed folders. Never overwrites. Requires human approval.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    preflight(ctx, input) {
      const file = resolveInRoots(str(input.path, 'path'), ctx.roots);
      if (typeof input.content !== 'string' || input.content.length > 200000) throw new ToolError('content must be a string under 200 KB');
      if (fs.existsSync(file)) throw new ToolError('file already exists; refusing to overwrite');
      return { file };
    },
    async run(ctx, input) {
      const { file } = this.preflight(ctx, input);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, input.content, { flag: 'wx' });
      return 'written';
    },
  },
  'web.fetch': {
    tier: 'read', untrusted: true,
    description: 'Fetch a web page from an allowed domain and return its text (up to 20 KB).',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run(ctx, input) { return fetchAllowed(ctx, str(input.url, 'url')); },
  },
  'db.query': {
    tier: 'read', untrusted: true,
    description: 'Run one read-only SQL SELECT against the data database. Returns at most 200 rows.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    async run(ctx, input) { return runReadOnlyQuery(ctx, str(input.sql, 'sql')); },
  },
  'note.save': {
    tier: 'internal', untrusted: false,
    description: 'Save a short note or report (shown in the workbench) for this run.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
    async run(ctx, input) {
      await ctx.pool.query('INSERT INTO notes (run_id, title, body) VALUES ($1, $2, $3)', [ctx.runId, clip(str(input.title, 'title'), 200), clip(str(input.body, 'body'), 20000)]);
      return 'saved';
    },
  },
};

// ---------- web.fetch ----------

function hostAllowed(host, domains) { return domains.some((d) => host === d || host.endsWith('.' + d)); }

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

async function fetchAllowed(ctx, rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    let u; try { u = new URL(url); } catch (e) { throw new ToolError('invalid URL'); }
    if (u.protocol !== 'https:' && !ctx.allowInsecureForTests) throw new ToolError('only https URLs are allowed');
    if (net.isIP(u.hostname)) throw new ToolError('IP addresses are not allowed');
    if (!hostAllowed(u.hostname.toLowerCase(), ctx.domains)) throw new ToolError('domain is not on this task\'s allowlist');
    if (!ctx.fetchImpl) {
      const addrs = await dns.lookup(u.hostname, { all: true });
      if (addrs.some((a) => privateAddress(a.address))) throw new ToolError('domain resolves to a private address');
    }
    const res = await (ctx.fetchImpl || fetch)(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'local-agent-workbench' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).toString(); continue; } // each hop re-checked
    if (!res.ok) throw new ToolError('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!/^(text\/|application\/(json|xml))/.test(type)) throw new ToolError('unsupported content type');
    const body = (await res.text()).slice(0, 400000);
    const text = /html/.test(type) ? body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : body;
    return clip(text);
  }
  throw new ToolError('too many redirects');
}

// ---------- db.query ----------

const FORBIDDEN_SQL = /\b(workbench|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|copy|pg_sleep|set_config|pg_terminate_backend|pg_cancel_backend)\b/i;

function checkSelect(sql) {
  const noComments = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(noComments)) throw new ToolError('only SELECT queries are allowed');
  if (noComments.includes(';')) throw new ToolError('only one statement is allowed');
  if (FORBIDDEN_SQL.test(noComments)) throw new ToolError('query uses a blocked name or function');
  return noComments;
}

// Defense in depth: validated text, READ ONLY transaction, statement timeout, row cap.
// For real protection also point DATA_DATABASE_URL at a role that only has SELECT on the tables you choose.
async function runReadOnlyQuery(ctx, sql) {
  const q = checkSelect(sql);
  if (!ctx.dataPool) throw new ToolError('no data database configured');
  const client = await ctx.dataPool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const res = await client.query('SELECT * FROM (' + q + ') AS q LIMIT 200');
    await client.query('ROLLBACK');
    return clip(JSON.stringify(res.rows));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw new ToolError('query failed: ' + String(e.message).slice(0, 200));
  } finally { client.release(); }
}

// Minimal input check against the tool's schema (required fields and string/number types).
function validateInput(tool, input) {
  const s = tool.input_schema;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolError('input must be an object');
  for (const k of s.required || []) if (!(k in input)) throw new ToolError('missing field: ' + k);
  for (const [k, spec] of Object.entries(s.properties)) if (k in input && typeof input[k] !== spec.type) throw new ToolError(k + ' must be a ' + spec.type);
}

module.exports = { registry, validateInput, checkSelect, clip, ToolError };
