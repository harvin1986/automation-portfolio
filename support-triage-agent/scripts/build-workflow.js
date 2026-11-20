#!/usr/bin/env node
// Assembles the n8n workflow JSON from the modules in src/.
//   node scripts/build-workflow.js                 -> workflows/support-triage-agent.json
//   node scripts/build-workflow.js --out <file>

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const outFile = argVal('--out') || path.join(root, 'workflows', 'support-triage-agent.json');

// Inline a module: drop its require() lines and everything from the exports marker down.
function inline(file) {
  const src = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  return src.split('// --- exports')[0].split('\n').filter((l) => !/require\(/.test(l)).join('\n').trim();
}
const M = { hmac: inline('hmac.js'), security: inline('security.js'), redact: inline('redact.js'), breaker: inline('breaker.js'), triage: inline('triage.js') };

// ---------- shared snippets (no backticks or template placeholders: these live inside template literals) ----------

const GET_SECRET = [
  "let secret = '';",
  "try { secret = $env.TRIAGE_WEBHOOK_SECRET || ''; } catch (e) {}",
  "if (!secret) { try { secret = $vars.TRIAGE_WEBHOOK_SECRET || ''; } catch (e) {} }",
].join('\n');

const FINALIZE = [
  'function finalize(sd, ctx, outcome, c, secret, now) {',
  '  const id = ctx.ticket.ticket_id;',
  "  const prio = (c && c.priority) || 'p3';",
  '  const due = dueAt(prio, now);',
  '  recordTicket(sd, id, { decision: outcome.decision, category: c && c.category, priority: prio }, now);',
  "  const summary = c && c.summary ? c.summary : '(no AI summary)';",
  "  const label = '[' + ((c && c.category) || 'unclassified') + '/' + prio + ']';",
  "  if (outcome.decision === 'auto_reply') {",
  "    return { decision: 'auto_reply', ticket_id: id, reply: { ticket_id: id, reply_text: c.draft_reply, sent_by: 'auto' },",
  "      response: { status: 'auto_replied', ticket_id: id, category: c.category, priority: prio, dueAt: due } };",
  '  }',
  "  if (outcome.decision === 'needs_approval') {",
  '    sd.pending = sd.pending || {};',
  '    sd.pending[id] = { draft: c.draft_reply, category: c.category, priority: prio, dueAt: due, createdAt: new Date(now).toISOString(), used: false };',
  '    const exp = Math.floor(now / 1000) + 86400;',
  "    const base = 'https://' + ctx.host + '/webhook/approve?token=';",
  "    const approveUrl = base + signToken(secret, id, 'approve', exp);",
  "    const rejectUrl = base + signToken(secret, id, 'reject', exp);",
  "    return { decision: 'needs_approval', ticket_id: id,",
  "      notify: { text: '*Approval needed* ' + id + ' ' + label + ' due ' + due + '\\n' + summary + '\\nWhy: ' + outcome.reasons.join('; ') + '\\nDraft: ' + c.draft_reply + '\\nApprove: ' + approveUrl + '\\nReject: ' + rejectUrl },",
  "      response: { status: 'pending_approval', ticket_id: id, reasons: outcome.reasons, dueAt: due } };",
  '  }',
  "  return { decision: 'escalate', ticket_id: id,",
  "    notify: { text: '*ESCALATION* ' + id + ' ' + label + ' due ' + due + '\\n' + summary + '\\nWhy: ' + outcome.reasons.join('; ') },",
  "    response: { status: 'escalated', ticket_id: id, reasons: outcome.reasons, dueAt: due } };",
  '}',
].join('\n');

// ---------- Code node bodies ----------

const verifyNode = `
${M.hmac}

${M.security}

const item = $input.first().json;
const h = item.headers || {};
${GET_SECRET}
let raw = null;
try { raw = await this.helpers.getBinaryDataBuffer(0, 'data'); } catch (e) {}
const fail = (reason, httpCode) => [{ json: { verified: false, httpCode: httpCode || 401, response: { status: 'rejected', reason } } }];
if (!secret) return fail('server_not_configured', 500);
const sig = verifyRequest({ secret, timestamp: h['x-timestamp'], signature: h['x-signature'], rawBody: raw, nowSec: Math.floor(Date.now() / 1000) });
if (!sig.ok) return fail(sig.reason, 401);
let parsed;
try { parsed = JSON.parse(Buffer.from(raw).toString('utf8')); } catch (e) { return fail('invalid_json', 400); }
const v = validateTicket(parsed);
if (!v.ok) return fail(v.reason, 400);
return [{ json: { verified: true, httpCode: 200, ticket: v.ticket, host: h.host || '' } }];
`.trim();

const dedupeNode = `
const sd = $getWorkflowStaticData('global');
sd.tickets = sd.tickets || {};
const item = $input.first().json;
const prior = sd.tickets[item.ticket.ticket_id] || null;
return [{ json: { ...item, duplicate: !!prior, httpCode: 200,
  response: prior ? { status: 'duplicate', ticket_id: item.ticket.ticket_id, priorDecision: prior.decision } : null } }];
`.trim();

const redactNode = `
${M.redact}

const item = $input.first().json;
const s = redactPII(item.ticket.subject);
const b = redactPII(item.ticket.body);
return [{ json: { ...item, redacted: { subject: s.text, body: b.text }, redactionCounts: mergeCounts(s.counts, b.counts) } }];
`.trim();

const breakerCheckNode = `
${M.breaker}

const sd = $getWorkflowStaticData('global');
sd.breaker = sd.breaker || { failures: 0, openUntil: 0 };
const item = $input.first().json;
return [{ json: { ...item, breakerOpen: isOpen(sd.breaker, Date.now()) } }];
`.trim();

const buildRequestNode = `
${M.triage}

const item = $input.first().json;
return [{ json: { ...item, claudeRequest: buildClaudeRequest(item.redacted.subject, item.redacted.body) } }];
`.trim();

const applyPolicyNode = `
${M.hmac}

${M.security}

${M.breaker}

${M.triage}

${FINALIZE}

${GET_SECRET}
const now = Date.now();
const ctx = $('Breaker Check').first().json;
const resp = $input.first().json;
const sd = $getWorkflowStaticData('global');
sd.breaker = sd.breaker || { failures: 0, openUntil: 0 };
const m = ensureMetrics(sd);
m.llmCalls += 1;
m.tokensIn += (resp.usage && resp.usage.input_tokens) || 0;
m.tokensOut += (resp.usage && resp.usage.output_tokens) || 0;
const block = (resp.content || []).find((b) => b.type === 'tool_use');
let outcome; let classification = null;
if (!block) {
  outcome = { decision: 'escalate', reasons: ['Model returned no tool call'] };
  m.llmFailures += 1; recordFailure(sd.breaker, now);
} else {
  recordSuccess(sd.breaker);
  classification = block.input;
  outcome = decide(classification);
}
const out = finalize(sd, ctx, outcome, outcome.decision === 'escalate' && !block ? null : classification, secret, now);
return [{ json: out }];
`.trim();

const manualRouteNode = `
${M.hmac}

${M.security}

${M.breaker}

${M.triage}

${FINALIZE}

${GET_SECRET}
const now = Date.now();
const ctx = $('Breaker Check').first().json;
const inp = $input.first().json;
const sd = $getWorkflowStaticData('global');
sd.breaker = sd.breaker || { failures: 0, openUntil: 0 };
const m = ensureMetrics(sd);
let reason = 'LLM circuit breaker is open; routed to a human';
if (inp && inp.error) {
  m.llmCalls += 1; m.llmFailures += 1;
  recordFailure(sd.breaker, now);
  // Failure reason only. Never store ticket text.
  reason = 'LLM call failed: ' + String((inp.error.message || JSON.stringify(inp.error))).slice(0, 200);
}
const out = finalize(sd, ctx, { decision: 'escalate', reasons: [reason] }, null, secret, now);
return [{ json: out }];
`.trim();

const handleApprovalNode = `
${M.hmac}

${M.security}

${M.triage}

${GET_SECRET}
const now = Date.now();
const sd = $getWorkflowStaticData('global');
const q = $input.first().json.query || {};
const done = (outcome, httpCode, status, extra) => [{ json: { outcome, httpCode, response: { status, ...(extra || {}) } } }];
if (!secret) return done('invalid', 500, 'server_not_configured');
const v = verifyToken(secret, q.token, Math.floor(now / 1000));
if (!v.ok) return done('invalid', 403, 'invalid_link', { reason: v.reason });
sd.pending = sd.pending || {};
const p = sd.pending[v.ticketId];
if (!p) return done('invalid', 404, 'unknown_ticket');
if (p.used) return done('invalid', 409, 'already_decided');
p.used = true; p.decision = v.action; p.decidedAt = new Date(now).toISOString();
const m = ensureMetrics(sd);
bump(m.byDecision, 'human_' + v.action);
if (v.action === 'reject') return done('rejected', 200, 'rejected', { ticket_id: v.ticketId });
return [{ json: { outcome: 'send', httpCode: 200, ticket_id: v.ticketId,
  reply: { ticket_id: v.ticketId, reply_text: p.draft, sent_by: 'human_approved' },
  response: { status: 'approved_and_sent', ticket_id: v.ticketId } } }];
`.trim();

const replyFailedNode = (source) => `
const sd = $getWorkflowStaticData('global');
sd.replyFailures = sd.replyFailures || [];
const ctx = $('${source}').first().json;
const err = $input.first().json;
const message = (err.error && (err.error.message || JSON.stringify(err.error))) || err.message || JSON.stringify(err);
sd.replyFailures.push({ at: new Date().toISOString(), ticket_id: ctx.ticket_id, error: String(message).slice(0, 300) });
if (sd.replyFailures.length > 200) sd.replyFailures.shift();
sd.metrics = sd.metrics || { byDecision: {}, byCategory: {}, byPriority: {}, llmCalls: 0, llmFailures: 0, tokensIn: 0, tokensOut: 0, replyFailures: 0 };
sd.metrics.replyFailures += 1;
return [{ json: { httpCode: 502, response: { status: 'reply_failed', ticket_id: ctx.ticket_id, message: 'Reply delivery failed. Recorded in the reply-failure list.' } } }];
`.trim();

const buildMetricsNode = `
${M.triage}

const sd = $getWorkflowStaticData('global');
return [{ json: { response: buildMetrics(sd, Date.now()) } }];
`.trim();

const buildDigestNode = `
${M.triage}

const sd = $getWorkflowStaticData('global');
const m = buildMetrics(sd, Date.now());
const lines = [
  '*Daily support triage digest*',
  'Tickets seen: ' + m.ticketsSeen,
  'Decisions: ' + JSON.stringify(m.byDecision),
  'Pending approvals: ' + m.pendingApprovals + ' (past SLA: ' + m.pendingPastSla.length + ')',
  'LLM calls: ' + m.llm.calls + ', failures: ' + m.llm.failures + ', tokens in/out: ' + m.llm.tokensIn + '/' + m.llm.tokensOut,
  'Reply delivery failures: ' + m.replyFailures,
];
if (m.pendingPastSla.length) lines.push('Overdue: ' + m.pendingPastSla.map((p) => p.ticket_id + ' (' + p.priority + ')').join(', '));
return [{ json: { notify: { text: lines.join('\\n') } } }];
`.trim();

// ---------- node helpers ----------

let n = 0;
const nid = () => 'node-' + String(++n).padStart(2, '0');

const code = (name, jsCode, pos) => ({ parameters: { jsCode }, id: nid(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos });

const respond = (name, body, status, pos) => ({
  parameters: { respondWith: 'json', responseBody: body, options: { responseCode: status } },
  id: nid(), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: pos,
});

const cond = (id, left, op, right) => ({ id, leftValue: left, rightValue: right, operator: op });
const condBlock = (conditions) => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions, combinator: 'and',
});

const ifNode = (name, left, pos) => ({
  parameters: { conditions: condBlock([cond('c-' + name.replace(/\W+/g, '-').toLowerCase(), left, { type: 'boolean', operation: 'true', singleValue: true }, '')]), options: {} },
  id: nid(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
});

const switchNode = (name, field, values, pos) => ({
  parameters: {
    rules: {
      values: values.map((v) => ({
        conditions: condBlock([cond('c-' + v, '={{ $json.' + field + ' }}', { type: 'string', operation: 'equals' }, v)]),
        renameOutput: true, outputKey: v,
      })),
    },
    options: {},
  },
  id: nid(), name, type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: pos,
});

const httpPost = (name, url, bodyExpr, pos, extra) => ({
  parameters: {
    method: 'POST', url, sendBody: true, specifyBody: 'json', jsonBody: bodyExpr, options: { timeout: 15000 },
  },
  id: nid(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, ...extra,
});

// Replace these URLs after import (see README).
const REPLY_API_URL = 'https://helpdesk.example.invalid/api/tickets/reply';
const APPROVER_WEBHOOK_URL = 'https://hooks.example.invalid/approvers';
const ONCALL_WEBHOOK_URL = 'https://hooks.example.invalid/oncall';
const DIGEST_WEBHOOK_URL = 'https://hooks.example.invalid/digest';

// ---------- nodes ----------

const nodes = [];

nodes.push({
  parameters: { httpMethod: 'POST', path: 'ticket', responseMode: 'responseNode', options: { rawBody: true } },
  id: nid(), name: 'Ticket Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 200], webhookId: 'b2d5f9a3-7c2e-4b68-8d4f-1e3a8c6b2f01',
});
nodes.push(code('Verify Request', verifyNode, [240, 200]));
nodes.push(ifNode('Verified?', '={{ $json.verified }}', [480, 200]));
nodes.push(respond('Respond Rejected', '={{ $json.response }}', '={{ $json.httpCode }}', [720, 380]));
nodes.push(code('Dedupe Check', dedupeNode, [720, 120]));
nodes.push(ifNode('Duplicate?', '={{ $json.duplicate }}', [960, 120]));
nodes.push(respond('Respond Duplicate', '={{ $json.response }}', 200, [1200, 20]));
nodes.push(code('Redact PII', redactNode, [1200, 200]));
nodes.push(code('Breaker Check', breakerCheckNode, [1440, 200]));
nodes.push(ifNode('Breaker Open?', '={{ $json.breakerOpen }}', [1680, 200]));
nodes.push(code('Build Claude Request', buildRequestNode, [1920, 120]));

nodes.push({
  parameters: {
    method: 'POST', url: 'https://api.anthropic.com/v1/messages', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.claudeRequest) }}', options: { timeout: 60000 },
  },
  id: nid(), name: 'Claude Classify', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2160, 120],
  retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueErrorOutput',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Anthropic API Key' } },
});

nodes.push(code('Apply Policy', applyPolicyNode, [2400, 80]));
nodes.push(code('Manual Route', manualRouteNode, [2400, 300]));
nodes.push(switchNode('Decision Switch', 'decision', ['auto_reply', 'needs_approval', 'escalate'], [2640, 200]));

nodes.push(httpPost('Send Auto Reply', REPLY_API_URL, '={{ JSON.stringify($json.reply) }}', [2880, 40], { onError: 'continueErrorOutput' }));
nodes.push(respond('Respond Auto Replied', "={{ $('Decision Switch').first().json.response }}", 200, [3120, 20]));
nodes.push(code('Reply Failed (Auto)', replyFailedNode('Decision Switch'), [3120, 140]));

nodes.push(httpPost('Notify Approver', APPROVER_WEBHOOK_URL, '={{ JSON.stringify($json.notify) }}', [2880, 240], { onError: 'continueRegularOutput' }));
nodes.push(respond('Respond Pending', "={{ $('Decision Switch').first().json.response }}", 202, [3120, 240]));

nodes.push(httpPost('Notify On-call', ONCALL_WEBHOOK_URL, '={{ JSON.stringify($json.notify) }}', [2880, 420], { onError: 'continueRegularOutput' }));
nodes.push(respond('Respond Escalated', "={{ $('Decision Switch').first().json.response }}", 202, [3120, 420]));

nodes.push(respond('Respond Reply Failed', '={{ $json.response }}', 502, [3360, 600]));

// approval flow
nodes.push({
  parameters: { httpMethod: 'GET', path: 'approve', responseMode: 'responseNode', options: {} },
  id: nid(), name: 'Approval Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 800], webhookId: 'b2d5f9a3-7c2e-4b68-8d4f-1e3a8c6b2f02',
});
nodes.push(code('Handle Approval', handleApprovalNode, [240, 800]));
nodes.push(switchNode('Approval Outcome', 'outcome', ['send', 'rejected', 'invalid'], [480, 800]));
nodes.push(httpPost('Send Approved Reply', REPLY_API_URL, '={{ JSON.stringify($json.reply) }}', [720, 720], { onError: 'continueErrorOutput' }));
nodes.push(respond('Respond Approved', "={{ $('Handle Approval').first().json.response }}", 200, [960, 700]));
nodes.push(code('Reply Failed (Approved)', replyFailedNode('Handle Approval'), [960, 820]));
nodes.push(respond('Respond Rejected Link', '={{ $json.response }}', 200, [720, 900]));
nodes.push(respond('Respond Invalid Link', '={{ $json.response }}', '={{ $json.httpCode }}', [720, 1020]));

// metrics + digest
nodes.push({
  parameters: { httpMethod: 'GET', path: 'metrics', authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
  id: nid(), name: 'Metrics Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 1200], webhookId: 'b2d5f9a3-7c2e-4b68-8d4f-1e3a8c6b2f03',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Metrics Access Key' } },
});
nodes.push(code('Build Metrics', buildMetricsNode, [240, 1200]));
nodes.push(respond('Respond Metrics', '={{ $json.response }}', 200, [480, 1200]));
nodes.push({
  parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 13 * * 1-5' }] } },
  id: nid(), name: 'Daily Digest', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 1400],
});
nodes.push(code('Build Digest', buildDigestNode, [240, 1400]));
nodes.push(httpPost('Post Digest', DIGEST_WEBHOOK_URL, '={{ JSON.stringify($json.notify) }}', [480, 1400], { onError: 'continueRegularOutput' }));

// ---------- connections ----------

const link = (to, index = 0) => ({ node: to, type: 'main', index });
const connections = {
  'Ticket Webhook': { main: [[link('Verify Request')]] },
  'Verify Request': { main: [[link('Verified?')]] },
  'Verified?': { main: [[link('Dedupe Check')], [link('Respond Rejected')]] },
  'Dedupe Check': { main: [[link('Duplicate?')]] },
  'Duplicate?': { main: [[link('Respond Duplicate')], [link('Redact PII')]] },
  'Redact PII': { main: [[link('Breaker Check')]] },
  'Breaker Check': { main: [[link('Breaker Open?')]] },
  'Breaker Open?': { main: [[link('Manual Route')], [link('Build Claude Request')]] },
  'Build Claude Request': { main: [[link('Claude Classify')]] },
  'Claude Classify': { main: [[link('Apply Policy')], [link('Manual Route')]] },
  'Apply Policy': { main: [[link('Decision Switch')]] },
  'Manual Route': { main: [[link('Decision Switch')]] },
  'Decision Switch': { main: [[link('Send Auto Reply')], [link('Notify Approver')], [link('Notify On-call')]] },
  'Send Auto Reply': { main: [[link('Respond Auto Replied')], [link('Reply Failed (Auto)')]] },
  'Reply Failed (Auto)': { main: [[link('Respond Reply Failed')]] },
  'Notify Approver': { main: [[link('Respond Pending')]] },
  'Notify On-call': { main: [[link('Respond Escalated')]] },
  'Approval Webhook': { main: [[link('Handle Approval')]] },
  'Handle Approval': { main: [[link('Approval Outcome')]] },
  'Approval Outcome': { main: [[link('Send Approved Reply')], [link('Respond Rejected Link')], [link('Respond Invalid Link')]] },
  'Send Approved Reply': { main: [[link('Respond Approved')], [link('Reply Failed (Approved)')]] },
  'Reply Failed (Approved)': { main: [[link('Respond Reply Failed')]] },
  'Metrics Webhook': { main: [[link('Build Metrics')]] },
  'Build Metrics': { main: [[link('Respond Metrics')]] },
  'Daily Digest': { main: [[link('Build Digest')]] },
  'Build Digest': { main: [[link('Post Digest')]] },
};

const workflow = { id: 'supportTriageAgent01', name: 'Support Triage Agent', nodes, connections, active: false, settings: { executionOrder: 'v1' }, pinData: {}, tags: [] };

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');
console.log('Wrote ' + outFile + ' (' + nodes.length + ' nodes)');
