#!/usr/bin/env node
// Sends a signed ticket to the workflow. No dependencies.
//   TRIAGE_WEBHOOK_SECRET=... node scripts/send-ticket.js <webhook-url> <ticket-index>
// Example: node scripts/send-ticket.js https://YOUR-HOST/webhook/ticket 0

const crypto = require('crypto');
const path = require('path');

const [url, idx = '0'] = process.argv.slice(2);
const secret = process.env.TRIAGE_WEBHOOK_SECRET;
if (!url || !secret) { console.error('Usage: TRIAGE_WEBHOOK_SECRET=... node scripts/send-ticket.js <url> [index]'); process.exit(1); }

const { expected, ...ticket } = require(path.join(__dirname, '..', 'samples', 'tickets.json'))[Number(idx)];
const body = JSON.stringify(ticket);
const ts = String(Math.floor(Date.now() / 1000));
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');

fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': sig }, body })
  .then(async (r) => { console.log(r.status, await r.text()); console.log('expected:', expected); })
  .catch((e) => { console.error(e.message); process.exit(1); });
