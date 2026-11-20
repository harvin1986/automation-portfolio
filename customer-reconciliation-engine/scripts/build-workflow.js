#!/usr/bin/env node
// Assembles the n8n workflow JSON from the modules in src/.
//   node scripts/build-workflow.js [--out <file>]

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const outFile = argVal('--out') || path.join(root, 'workflows', 'customer-reconciliation-engine.json');

function inline(file) {
  const src = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  return src.split('// --- exports')[0].split('\n').filter((l) => !/require\(/.test(l)).join('\n').trim();
}
const M = { hmac: inline('hmac.js'), strings: inline('strings.js'), match: inline('match.js'), diff: inline('diff.js'), adj: inline('adjudicate.js') };

// Node bodies are template literals: no backticks or dollar-brace sequences inside them.

const MAX_LIST = 500;

const prepareRunNode = `
const DEFAULT_DRY_RUN = true; // safe by default: writes only happen when a run explicitly sets dryRun to false
const now = Date.now();
const sd = $getWorkflowStaticData('global');
const body = ($input.first().json || {}).body || {};
const dryRun = body.dryRun === undefined ? DEFAULT_DRY_RUN : (body.dryRun === true || body.dryRun === 'true');
const force = body.force === true;
if (sd.lock && sd.lock.until > now) {
  sd.skipped = (sd.skipped || 0) + 1;
  return [{ json: { acquired: false, reason: 'run_in_progress' } }];
}
const runId = 'run-' + now.toString(36);
sd.lock = { runId, until: now + 30 * 60000 }; // a crashed run cannot block future runs for more than 30 minutes
return [{ json: { acquired: true, runId, startedAt: new Date(now).toISOString(), dryRun, force } }];
`.trim();

const collectCrmNode = `
const crm = [];
for (const page of $input.all()) {
  const d = page.json.data;
  if (!Array.isArray(d)) throw new Error('CRM response page has no data array');
  crm.push(...d);
}
return [{ json: { crm } }];
`.trim();

const collectBillingNode = `
const bill = [];
for (const page of $input.all()) {
  const d = page.json.data;
  if (!Array.isArray(d)) throw new Error('Billing response page has no data array');
  bill.push(...d);
}
return [{ json: { runCtx: $('Prepare Run').first().json, crm: $('Collect CRM').first().json.crm, billing: bill } }];
`.trim();

const matchRecordsNode = `
${M.strings}

${M.match}

const sd = $getWorkflowStaticData('global');
const item = $input.first().json;
const match = matchRecords(item.crm, item.billing, sd.links || {}, sd.rejected || {});
return [{ json: { ...item, match } }];
`.trim();

const buildAdjNode = `
${M.adj}

const item = $input.first().json;
const crmById = Object.fromEntries(item.crm.map((r) => [r.id, r]));
const billById = Object.fromEntries(item.billing.map((r) => [r.id, r]));
const built = buildAdjudicationRequest(item.match.ambiguous, crmById, billById);
return [{ json: { claudeRequest: built.request, pairMap: built.pairMap } }];
`.trim();

const resolveNode = `
${M.adj}

const now = Date.now();
const sd = $getWorkflowStaticData('global');
const item = $('Match Records').first().json;
const inp = $input.first().json;
let pairMap = null;
try { pairMap = $('Build Adjudication Request').first().json.pairMap; } catch (e) {}
let modelInput = null; let llmFailed = false; let usage = null;
if (pairMap) {
  if (inp.error || !inp.content) llmFailed = true;
  else {
    usage = inp.usage || null;
    const block = (inp.content || []).find((b) => b.type === 'tool_use');
    modelInput = block ? block.input : null;
  }
}
const res = resolveAmbiguous(item.match.ambiguous, pairMap || {}, modelInput);
// Pairs beyond the batch limit were never asked about: they stay in the review queue.
const asked = new Set(Object.values(pairMap || {}).map((p) => p.crm_id + '|' + p.billing_id));
for (const a of item.match.ambiguous) if (!asked.has(a.crm_id + '|' + a.billing_id)) res.review.push({ ...a, reason: 'Not adjudicated (batch limit)' });
if (!item.runCtx.dryRun) {
  sd.links = sd.links || {}; sd.rejected = sd.rejected || {};
  for (const a of res.link) sd.links[a.crm_id] = { billing_id: a.billing_id, method: 'llm_rules', at: new Date(now).toISOString() };
  for (const a of res.reject) sd.rejected[a.crm_id + '|' + a.billing_id] = new Date(now).toISOString();
  // Newly confirmed deterministic matches are cached too, so they never need re-deciding.
  for (const m of item.match.matched) if (m.method !== 'cached' && m.method !== 'fuzzy_high') sd.links[m.crm_id] = { billing_id: m.billing_id, method: m.method, at: new Date(now).toISOString() };
}
// The review queue and conflict list are rebuilt every run from current data. IDs and scores only, no personal data.
sd.review = res.review.map((r) => ({ crm_id: r.crm_id, billing_id: r.billing_id, score: r.score, reason: r.reason })).slice(0, ${MAX_LIST});
sd.conflicts = item.match.conflicts.slice(0, ${MAX_LIST});
const linked = res.link.map((a) => ({ crm_id: a.crm_id, billing_id: a.billing_id, method: 'llm_rules', score: a.score }));
return [{ json: { runCtx: item.runCtx, crm: item.crm, billing: item.billing, match: item.match,
  finalMatched: item.match.matched.concat(linked),
  adjudication: { asked: asked.size, linked: res.link.length, rejected: res.reject.length, review: res.review.length, llmFailed, usage } } }];
`.trim();

const planActionsNode = `
${M.hmac}

${M.strings}

${M.diff}

const item = $input.first().json;
const crmById = Object.fromEntries(item.crm.map((r) => [r.id, r]));
const billById = Object.fromEntries(item.billing.map((r) => [r.id, r]));
const { actions, skippedBlank } = planActions(item.finalMatched, crmById, billById);
const limit = guardLimit(item.finalMatched.length);
const guardTripped = actions.length > limit && !item.runCtx.force;
const apply = actions.length > 0 && !item.runCtx.dryRun && !guardTripped;
const byMethod = {};
for (const m of item.finalMatched) byMethod[m.method] = (byMethod[m.method] || 0) + 1;
const stats = {
  crmFetched: item.crm.length, billingFetched: item.billing.length, matched: item.finalMatched.length, byMethod,
  unmatchedCrm: item.match.unmatchedCrm.length, orphanBilling: item.match.orphanBilling.length, conflicts: item.match.conflicts.length,
  adjudication: item.adjudication, plannedActions: actions.length, skippedBlankFields: skippedBlank.length, guardLimit: limit,
  driftPct: item.finalMatched.length ? Math.round(1000 * new Set(actions.map((a) => a.record_id)).size / item.finalMatched.length) / 10 : 0,
};
return [{ json: { runCtx: item.runCtx, actions, apply, guardTripped, stats } }];
`.trim();

const splitNode = (target) => `
const plan = $('Plan Actions').first().json;
return plan.actions.filter((a) => a.target === '${target}').map((a) => ({ json: a }));
`.trim();

const finalizeNode = `
const now = Date.now();
const sd = $getWorkflowStaticData('global');
const plan = $('Plan Actions').first().json;
const results = [];
for (const [split, apply] of [['Split Billing Updates', 'Apply to Billing'], ['Split CRM Updates', 'Apply to CRM']]) {
  let sent = []; let resp = [];
  try { sent = $(split).all(); } catch (e) {}
  try { resp = $(apply).all(); } catch (e) {}
  sent.forEach((s, i) => {
    const r = resp[i] && resp[i].json;
    const err = !r ? 'no response' : r.error ? (r.error.message || JSON.stringify(r.error)) : null;
    results.push({ target: s.json.target, record_id: s.json.record_id, fields: Object.keys(s.json.patch), key: s.json.idempotency_key, error: err ? String(err).slice(0, 200) : null });
  });
}
const failed = results.filter((r) => r.error);
// Dead letter keeps ids, field names and the error only. Never field values.
sd.deadLetter = (sd.deadLetter || []).concat(failed.map((f) => ({ at: new Date(now).toISOString(), target: f.target, record_id: f.record_id, fields: f.fields, error: f.error }))).slice(-200);
let status = 'success';
if (plan.runCtx.dryRun) status = 'dry_run';
else if (plan.guardTripped) status = 'halted_guard';
else if (failed.length) status = 'partial';
const summary = { runId: plan.runCtx.runId, status, startedAt: plan.runCtx.startedAt, finishedAt: new Date(now).toISOString(),
  applied: results.length - failed.length, failed: failed.length, ...plan.stats, reviewQueue: (sd.review || []).length };
sd.lastRun = summary;
if (sd.lock && sd.lock.runId === plan.runCtx.runId) sd.lock = null;
const lines = [
  '*Reconciliation run ' + summary.runId + '*: ' + status.toUpperCase() + (plan.runCtx.dryRun ? ' (no changes written)' : ''),
  'Records: CRM ' + summary.crmFetched + ', billing ' + summary.billingFetched + ', matched ' + summary.matched + ', drift ' + summary.driftPct + '%',
  'Planned ' + summary.plannedActions + ', applied ' + summary.applied + ', failed ' + summary.failed,
  'Needs attention: review ' + summary.reviewQueue + ', conflicts ' + summary.conflicts + ', unmatched CRM ' + summary.unmatchedCrm + ', orphan billing ' + summary.orphanBilling,
];
if (plan.guardTripped) lines.push('HALTED: ' + summary.plannedActions + ' changes exceeds the safety limit of ' + summary.guardLimit + '. Re-run with force=true after checking the data.');
return [{ json: { report: summary, notify: { text: lines.join('\\n') } } }];
`.trim();

const abortNode = `
const now = Date.now();
const sd = $getWorkflowStaticData('global');
const err = $input.first().json;
const message = (err.error && (err.error.message || JSON.stringify(err.error))) || err.message || JSON.stringify(err);
let runId = null;
try { runId = $('Prepare Run').first().json.runId; } catch (e) {}
sd.lastRun = { runId, status: 'failed', finishedAt: new Date(now).toISOString(), error: String(message).slice(0, 200) };
if (sd.lock && sd.lock.runId === runId) sd.lock = null; // release so the next run is not blocked
return [{ json: { notify: { text: '*Reconciliation run ' + runId + ' FAILED* while fetching data: ' + String(message).slice(0, 200) + '. No changes were written.' } } }];
`.trim();

const buildReviewNode = `
const sd = $getWorkflowStaticData('global');
return [{ json: { httpCode: 200, response: { lastRun: sd.lastRun || null, reviewQueue: sd.review || [], conflicts: sd.conflicts || [], deadLetter: sd.deadLetter || [], linksCached: Object.keys(sd.links || {}).length } } }];
`.trim();

const applyDecisionNode = `
const sd = $getWorkflowStaticData('global');
const b = ($input.first().json || {}).body || {};
const bad = (code, status) => [{ json: { httpCode: code, response: { status } } }];
if (typeof b.crm_id !== 'string' || typeof b.billing_id !== 'string' || (b.decision !== 'link' && b.decision !== 'reject')) return bad(400, 'invalid_request');
const entry = (sd.review || []).find((r) => r.crm_id === b.crm_id && r.billing_id === b.billing_id);
if (!entry) return bad(404, 'not_in_review_queue');
sd.links = sd.links || {}; sd.rejected = sd.rejected || {};
if (b.decision === 'link') sd.links[b.crm_id] = { billing_id: b.billing_id, method: 'human', at: new Date().toISOString() };
else sd.rejected[b.crm_id + '|' + b.billing_id] = new Date().toISOString();
sd.review = sd.review.filter((r) => r !== entry);
return [{ json: { httpCode: 200, response: { status: 'recorded', decision: b.decision } } }];
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
const ifNode = (name, left, pos) => ({
  parameters: {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [cond('c-' + name.replace(/\W+/g, '-').toLowerCase(), left, { type: 'boolean', operation: 'true', singleValue: true }, '')], combinator: 'and' },
    options: {},
  },
  id: nid(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
});
const post = (name, url, bodyExpr, pos, extra) => ({
  parameters: { method: 'POST', url, sendBody: true, specifyBody: 'json', jsonBody: bodyExpr, options: { timeout: 15000 } },
  id: nid(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, ...extra,
});
const fetchNode = (name, url, credName, pos) => ({
  parameters: {
    method: 'GET', url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendQuery: true, queryParameters: { parameters: [{ name: 'limit', value: '200' }] },
    options: {
      timeout: 30000,
      pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'cursor', value: '={{ $response.body.next_cursor }}' }] },
        paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.next_cursor }}', limitPagesFetched: true, maxRequests: 200 } },
    },
  },
  id: nid(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueErrorOutput',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: credName } },
});
const applyNode = (name, credName, pos) => ({
  parameters: {
    method: '={{ $json.method }}', url: '={{ $json.url }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'Idempotency-Key', value: '={{ $json.idempotency_key }}' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.patch) }}',
    options: { timeout: 20000, batching: { batch: { batchSize: 10, batchInterval: 1000 } } },
  },
  id: nid(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: credName } },
});

const CRM_URL = 'https://crm.example.invalid/api/contacts';
const BILLING_URL = 'https://billing.example.invalid/api/accounts';
const REPORT_URL = 'https://hooks.example.invalid/reconciliation';

// ---------- nodes ----------

const nodes = [];
nodes.push({ parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 * * * *' }] } }, id: nid(), name: 'Hourly Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 100] });
nodes.push({
  parameters: { httpMethod: 'POST', path: 'run', authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
  id: nid(), name: 'Manual Run Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], webhookId: 'c3e6a0b4-8d3f-4c79-9e50-2f4b9d7c3a01',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Reconciliation Admin Key' } },
});
nodes.push(code('Prepare Run', prepareRunNode, [240, 200]));
nodes.push(ifNode('Lock Acquired?', '={{ $json.acquired }}', [480, 200]));
nodes.push(code('Log Skipped Run', "return [{ json: { skipped: true } }];", [720, 340]));
nodes.push(fetchNode('Fetch CRM', CRM_URL, 'CRM API Key', [720, 120]));
nodes.push(code('Collect CRM', collectCrmNode, [960, 120]));
nodes.push(fetchNode('Fetch Billing', BILLING_URL, 'Billing API Key', [1200, 120]));
nodes.push(code('Collect Billing', collectBillingNode, [1440, 120]));
nodes.push(code('Abort Run', abortNode, [1200, 360]));
nodes.push(post('Post Alert', REPORT_URL, '={{ JSON.stringify($json.notify) }}', [1440, 360], { onError: 'continueRegularOutput' }));
nodes.push(code('Match Records', matchRecordsNode, [1680, 120]));
nodes.push(ifNode('Needs Adjudication?', '={{ $json.match.ambiguous.length > 0 }}', [1920, 120]));
nodes.push(code('Build Adjudication Request', buildAdjNode, [2160, 20]));
nodes.push({
  parameters: {
    method: 'POST', url: 'https://api.anthropic.com/v1/messages', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.claudeRequest) }}', options: { timeout: 60000 },
  },
  id: nid(), name: 'Claude Adjudicate', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2400, 20],
  retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Anthropic API Key' } },
});
nodes.push(code('Resolve Ambiguous', resolveNode, [2640, 120]));
nodes.push(code('Plan Actions', planActionsNode, [2880, 120]));
nodes.push(ifNode('Apply Changes?', '={{ $json.apply }}', [3120, 120]));
nodes.push(ifNode('Has Billing Updates?', "={{ $('Plan Actions').first().json.actions.filter((a) => a.target === 'billing').length > 0 }}", [3360, 40]));
nodes.push(code('Split Billing Updates', splitNode('billing'), [3600, 0]));
nodes.push(applyNode('Apply to Billing', 'Billing API Key', [3840, 0]));
nodes.push(ifNode('Has CRM Updates?', "={{ $('Plan Actions').first().json.actions.filter((a) => a.target === 'crm').length > 0 }}", [4080, 120]));
nodes.push(code('Split CRM Updates', splitNode('crm'), [4320, 60]));
nodes.push(applyNode('Apply to CRM', 'CRM API Key', [4560, 60]));
nodes.push(code('Finalize Run', finalizeNode, [4800, 200]));
nodes.push(post('Post Report', REPORT_URL, '={{ JSON.stringify($json.notify) }}', [5040, 200], { onError: 'continueRegularOutput' }));

nodes.push({
  parameters: { httpMethod: 'GET', path: 'review', authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
  id: nid(), name: 'Review Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 700], webhookId: 'c3e6a0b4-8d3f-4c79-9e50-2f4b9d7c3a02',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Reconciliation Admin Key' } },
});
nodes.push(code('Build Review', buildReviewNode, [240, 700]));
nodes.push(respond('Respond Review', '={{ $json.response }}', '={{ $json.httpCode }}', [480, 700]));
nodes.push({
  parameters: { httpMethod: 'POST', path: 'decide', authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
  id: nid(), name: 'Decide Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 900], webhookId: 'c3e6a0b4-8d3f-4c79-9e50-2f4b9d7c3a03',
  credentials: { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Reconciliation Admin Key' } },
});
nodes.push(code('Apply Decision', applyDecisionNode, [240, 900]));
nodes.push(respond('Respond Decision', '={{ $json.response }}', '={{ $json.httpCode }}', [480, 900]));

// ---------- connections ----------

const link = (to, index = 0) => ({ node: to, type: 'main', index });
const connections = {
  'Hourly Schedule': { main: [[link('Prepare Run')]] },
  'Manual Run Webhook': { main: [[link('Prepare Run')]] },
  'Prepare Run': { main: [[link('Lock Acquired?')]] },
  'Lock Acquired?': { main: [[link('Fetch CRM')], [link('Log Skipped Run')]] },
  'Fetch CRM': { main: [[link('Collect CRM')], [link('Abort Run')]] },
  'Collect CRM': { main: [[link('Fetch Billing')]] },
  'Fetch Billing': { main: [[link('Collect Billing')], [link('Abort Run')]] },
  'Collect Billing': { main: [[link('Match Records')]] },
  'Abort Run': { main: [[link('Post Alert')]] },
  'Match Records': { main: [[link('Needs Adjudication?')]] },
  'Needs Adjudication?': { main: [[link('Build Adjudication Request')], [link('Resolve Ambiguous')]] },
  'Build Adjudication Request': { main: [[link('Claude Adjudicate')]] },
  'Claude Adjudicate': { main: [[link('Resolve Ambiguous')]] },
  'Resolve Ambiguous': { main: [[link('Plan Actions')]] },
  'Plan Actions': { main: [[link('Apply Changes?')]] },
  'Apply Changes?': { main: [[link('Has Billing Updates?')], [link('Finalize Run')]] },
  'Has Billing Updates?': { main: [[link('Split Billing Updates')], [link('Has CRM Updates?')]] },
  'Split Billing Updates': { main: [[link('Apply to Billing')]] },
  'Apply to Billing': { main: [[link('Has CRM Updates?')]] },
  'Has CRM Updates?': { main: [[link('Split CRM Updates')], [link('Finalize Run')]] },
  'Split CRM Updates': { main: [[link('Apply to CRM')]] },
  'Apply to CRM': { main: [[link('Finalize Run')]] },
  'Finalize Run': { main: [[link('Post Report')]] },
  'Review Webhook': { main: [[link('Build Review')]] },
  'Build Review': { main: [[link('Respond Review')]] },
  'Decide Webhook': { main: [[link('Apply Decision')]] },
  'Apply Decision': { main: [[link('Respond Decision')]] },
};

const workflow = { id: 'customerReconEngine01', name: 'Customer Reconciliation Engine', nodes, connections, active: false, settings: { executionOrder: 'v1' }, pinData: {}, tags: [] };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');
console.log('Wrote ' + outFile + ' (' + nodes.length + ' nodes)');
