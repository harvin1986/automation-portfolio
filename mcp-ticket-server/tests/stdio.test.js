'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'mcp-ticket-server.js');

test('end to end over real stdio: demo mode, protocol-clean stdout, audit file written', async () => {
  const audit = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-')), 'audit.jsonl');
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: { ...process.env, TICKETS_API_URL: '', MCP_AUDIT_FILE: audit }, stderr: 'ignore' }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepStrictEqual(tools, ['queue_stats', 'tickets_get', 'tickets_search']);
  const r = await client.callTool({ name: 'tickets_search', arguments: { query: 'login' } });
  assert.strictEqual(r.structuredContent.items[0].id, 'T-1001');
  await client.close();
  const lines = fs.readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines[0].tool, 'tickets_search');
  assert.strictEqual(fs.statSync(audit).mode & 0o077, 0, 'audit file is private to the owner');
});

test('configuration errors fail fast with a clear message on stderr and nothing on stdout', () => {
  const r = spawnSync(process.execPath, [bin], { env: { ...process.env, TICKETS_API_URL: 'http://127.0.0.1:1', TICKETS_API_TOKEN: '' }, encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /TICKETS_API_TOKEN is required/);
  assert.strictEqual(r.stdout, '');
});
