const crypto = require('crypto');

const SECRET = 'test-secret-do-not-use';

function signedTicket(ticket, { secret = SECRET, ts, host = 'example.app.n8n.cloud', tamper = false, nowMs } = {}) {
  const raw = Buffer.from(JSON.stringify(ticket));
  const timestamp = String(ts != null ? ts : Math.floor((nowMs || Date.parse('2026-11-19T12:00:00Z')) / 1000));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex');
  const sent = tamper ? Buffer.from(JSON.stringify({ ...ticket, body: ticket.body + ' extra' })) : raw;
  return { json: { headers: { 'x-timestamp': timestamp, 'x-signature': sig, host }, body: ticket, query: {} }, binary: { data: { buf: sent } } };
}

// Builds a canned Claude Messages API response containing a tool_use block.
function claudeReply(input, usage = { input_tokens: 400, output_tokens: 120 }) {
  return { model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu_1', name: 'record_triage', input }] };
}

const goodInput = (over = {}) => ({
  category: 'technical', priority: 'p3', sentiment: 'neutral', summary: 'Customer cannot export a report.',
  draft_reply: 'Thanks for reaching out. Please try clearing your cache and exporting again; we are looking into it.',
  contains_commitment: false, suspicious_content: false, confidence: 0.93, ...over,
});

module.exports = { SECRET, signedTicket, claudeReply, goodInput };
