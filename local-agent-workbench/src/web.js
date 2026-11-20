const http = require('http');
const crypto = require('crypto');
const audit = require('./audit');

// Local-only approval console. Defenses: loopback bind, Host allowlist (DNS rebinding), session token,
// per-session CSRF token, strict CSP, and HTML escaping of everything that came from a model, file or web page.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tsEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function page(title, body) {
  return '<!doctype html><meta charset="utf-8"><title>' + esc(title) + '</title><style>body{font:15px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}pre{background:#f5f5f5;padding:8px;overflow:auto;white-space:pre-wrap}.warn{color:#b45309;font-weight:600}button{padding:6px 14px;margin-right:6px}nav a{margin-right:1rem}</style><nav><a href="/">Dashboard</a><a href="/audit">Audit log</a></nav>' + body;
}

function createWeb({ pool, agent, token, port = 0, host = '127.0.0.1' }) {
  const csrf = crypto.createHash('sha256').update('csrf:' + token).digest('hex');
  let allowedHosts = new Set();

  const send = (res, code, html, extra = {}) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', ...extra });
    res.end(html);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 10000) { reject(new Error('too large')); req.destroy(); } }); req.on('end', () => resolve(new URLSearchParams(b)));
  });
  const cookieOk = (req) => { const m = /(?:^|;\s*)wb_session=([^;]+)/.exec(req.headers.cookie || ''); return !!m && tsEq(decodeURIComponent(m[1]), token); };

  async function dashboard() {
    const pending = (await pool.query("SELECT a.*, t.name AS task FROM approvals a JOIN runs r ON r.id = a.run_id JOIN tasks t ON t.id = r.task_id WHERE a.status = 'pending' ORDER BY a.created_at")).rows;
    const runs = (await pool.query('SELECT r.id, t.name, r.status, r.trigger, r.created_at, r.steps FROM runs r JOIN tasks t ON t.id = r.task_id ORDER BY r.created_at DESC LIMIT 25')).rows;
    let h = '<h1>Approvals waiting</h1>';
    h += pending.length ? '' : '<p>Nothing is waiting for you.</p>';
    for (const a of pending) {
      h += '<div><h3>' + esc(a.task) + ': ' + esc(a.tool) + '</h3>' + (a.tainted ? '<p class="warn">This run read untrusted content (a file, web page or database) before proposing this action. Check the details carefully.</p>' : '') +
        '<pre>' + esc(JSON.stringify(a.input, null, 2)) + '</pre><p>Expires ' + esc(a.expires_at.toISOString()) + '</p>' +
        ['approve', 'reject'].map((d) => '<form method="post" action="/approvals/' + esc(a.id) + '/decide" style="display:inline"><input type="hidden" name="csrf" value="' + csrf + '"><input type="hidden" name="decision" value="' + d + '"><button>' + (d === 'approve' ? 'Approve' : 'Reject') + '</button></form>').join('') + '</div>';
    }
    h += '<h1>Recent runs</h1><table><tr><th>Task</th><th>Status</th><th>Trigger</th><th>Steps</th><th>Created</th></tr>' +
      runs.map((r) => '<tr><td><a href="/runs/' + esc(r.id) + '">' + esc(r.name) + '</a></td><td>' + esc(r.status) + '</td><td>' + esc(r.trigger) + '</td><td>' + r.steps + '</td><td>' + esc(r.created_at.toISOString()) + '</td></tr>').join('') + '</table>';
    return page('Workbench', h);
  }

  async function runPage(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const r = (await pool.query('SELECT r.*, t.name AS task FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = $1', [id])).rows[0];
    if (!r) return null;
    const steps = (await pool.query('SELECT * FROM steps WHERE run_id = $1 ORDER BY seq', [id])).rows;
    return page('Run', '<h1>' + esc(r.task) + '</h1><p>Status: <b>' + esc(r.status) + '</b>' + (r.tainted ? ' <span class="warn">(read untrusted content)</span>' : '') + '</p>' +
      (r.result ? '<h3>Result</h3><pre>' + esc(r.result) + '</pre>' : '') + (r.error ? '<h3>Error</h3><pre>' + esc(r.error) + '</pre>' : '') +
      '<h3>Steps</h3><table><tr><th>#</th><th>Kind</th><th>Name</th><th>OK</th><th>Input / output</th></tr>' +
      steps.map((s) => '<tr><td>' + s.seq + '</td><td>' + esc(s.kind) + '</td><td>' + esc(s.name) + '</td><td>' + (s.ok ? 'yes' : 'no') + '</td><td><pre>' + esc(JSON.stringify({ input: s.input, output: s.output }, null, 1)) + '</pre></td></tr>').join('') + '</table>');
  }

  async function auditPage() {
    const v = await audit.verify(pool);
    const rows = (await pool.query('SELECT id, at, actor, event, detail FROM audit_log ORDER BY id DESC LIMIT 100')).rows;
    return page('Audit log', '<h1>Audit log</h1><p>Chain check: ' + (v.ok ? '<b>intact</b> (' + v.entries + ' entries)' : '<b class="warn">BROKEN at entry ' + v.brokenAt + '</b>') + '</p><table><tr><th>#</th><th>When</th><th>Actor</th><th>Event</th><th>Detail</th></tr>' +
      rows.map((r) => '<tr><td>' + r.id + '</td><td>' + esc(r.at.toISOString()) + '</td><td>' + esc(r.actor) + '</td><td>' + esc(r.event) + '</td><td><pre>' + esc(JSON.stringify(r.detail)) + '</pre></td></tr>').join('') + '</table>');
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host).toLowerCase())) return send(res, 403, 'Forbidden host');
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') !== null) {
        if (!tsEq(url.searchParams.get('token'), token)) return send(res, 401, 'Unauthorized');
        return send(res, 302, '', { location: '/', 'set-cookie': 'wb_session=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Strict; Path=/' });
      }
      if (!cookieOk(req)) return send(res, 401, page('Sign in', '<p>Open the URL printed by <code>workbench start</code> (it includes your access token).</p>'));
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await dashboard());
      if (req.method === 'GET' && url.pathname === '/audit') return send(res, 200, await auditPage());
      let m = /^\/runs\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) { const h = await runPage(m[1]); return h ? send(res, 200, h) : send(res, 404, 'Not found'); }
      m = /^\/approvals\/([0-9a-f-]{36})\/decide$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, '').toLowerCase())) return send(res, 403, 'Forbidden origin');
        const body = await readBody(req);
        if (!tsEq(body.get('csrf') || '', csrf)) return send(res, 403, 'Bad CSRF token');
        const r = await agent.decide(m[1], body.get('decision'), 'ui');
        return send(res, r.ok ? 302 : 409, r.ok ? '' : 'Could not record decision: ' + esc(r.error), r.ok ? { location: '/' } : {});
      }
      return send(res, 404, 'Not found');
    } catch (e) { return send(res, 500, 'Server error'); }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const p = server.address().port;
      allowedHosts = new Set(['127.0.0.1:' + p, 'localhost:' + p]);
      resolve({ server, port: p, url: 'http://127.0.0.1:' + p + '/?token=' + token, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { createWeb, esc };
