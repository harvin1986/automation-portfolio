'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createApi } = require('../src/api/server');
const { HttpBackend } = require('../src/backend');
const { createServer } = require('../src/server');
const { createAudit } = require('../src/audit');

const cleanups = new Set();
async function closeAll() { for (const fn of [...cleanups]) { cleanups.delete(fn); try { await fn(); } catch { /* already closed */ } } }

async function startApi(opts) { const api = createApi(opts); const srv = await api.listen(0); cleanups.add(srv.close); return { api, srv, backend: new HttpBackend({ baseUrl: srv.url, token: srv.token, sleep: async () => {} }) }; }

// A real MCP client connected to the server over an in-memory transport, backed by the real HTTP API.
async function connect({ allowWrites = false, redact = true, apiOpts, serverOpts } = {}) {
  const { api, srv, backend } = await startApi(apiOpts);
  const audit = createAudit({ stream: null });
  const server = createServer({ backend, allowWrites, redact, audit, ...serverOpts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.add(() => client.close()); cleanups.add(() => server.close());
  return { api, backend, client, audit, server, async close() { await client.close(); await server.close(); await srv.close(); } };
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const text = (r) => r.content.map((x) => x.text).join('\n');

module.exports = { closeAll, startApi, connect, call, text };
