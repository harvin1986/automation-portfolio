#!/usr/bin/env node
'use strict';
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createServer } = require('../src/server');
const { HttpBackend } = require('../src/backend');
const { createApi } = require('../src/api/server');
const { createAudit } = require('../src/audit');

const flag = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

async function main() {
  const log = (m) => process.stderr.write(`[ticketing-mcp] ${m}\n`); // stdout is reserved for the protocol
  let baseUrl = process.env.TICKETS_API_URL, token = process.env.TICKETS_API_TOKEN, demo = null;
  if (!baseUrl) {
    demo = await createApi({ token: 'demo-token' }).listen(0);
    baseUrl = demo.url; token = demo.token;
    log(`TICKETS_API_URL not set: running against a built-in demo API with sample tickets (${baseUrl}).`);
  } else if (!token) { log('TICKETS_API_TOKEN is required when TICKETS_API_URL is set.'); process.exit(1); }

  const allowWrites = flag(process.env.MCP_ALLOW_WRITES, false);
  const server = createServer({
    backend: new HttpBackend({ baseUrl, token, timeoutMs: Number(process.env.TICKETS_TIMEOUT_MS) || 8000 }),
    allowWrites, redact: flag(process.env.MCP_REDACT_PII, true),
    audit: createAudit({ file: process.env.MCP_AUDIT_FILE || null }),
  });
  await server.connect(new StdioServerTransport());
  log(`ready (${allowWrites ? 'writes enabled, confirmation required' : 'read-only'})`);
  const stop = async () => { try { await server.close(); if (demo) await demo.close(); } finally { process.exit(0); } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
}
main().catch((e) => { process.stderr.write(`[ticketing-mcp] fatal: ${e.message}\n`); process.exit(1); });
