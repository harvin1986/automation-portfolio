#!/usr/bin/env node
// Assembles the n8n workflow JSON from the source files in src/.
// Usage:
//   node scripts/build-workflow.js                      -> workflows/document-intake-agent.json
//   node scripts/build-workflow.js --mock-url <url> --out <file>   (local test variant, no credentials)

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const mockUrl = argVal('--mock-url');
const outFile = argVal('--out') || path.join(root, 'workflows', 'document-intake-agent.json');

function inline(file) {
  const src = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  return src.split('// --- exports')[0].trim();
}

const validateSrc = inline('validate.js');
const requestSrc = inline('claude-request.js');

// ---------- Code node bodies ----------

const checkDuplicate = `
const sd = $getWorkflowStaticData('global');
sd.seen = sd.seen || {};
const item = $input.first().json;
const prior = sd.seen[item.idempotencyKey] || null;
return [{ json: { ...item, duplicate: !!prior, priorResult: prior } }];
`.trim();

const buildClaudeRequest = `
${requestSrc}

const item = $input.first().json;
return [{ json: { ...item, claudeRequest: buildClaudeRequest(item.text) } }];
`.trim();

const validateNode = `
${validateSrc}

const ctx = $('Build Claude Request').first().json;
const resp = $input.first().json;
const fileName = $('Intake Webhook').first().binary?.file?.fileName || 'unknown';
const block = (resp.content || []).find((b) => b.type === 'tool_use');

let extraction = null;
let outcome;
if (!block) {
  outcome = { status: 'needs_review', reasons: ['Model returned no tool call'] };
} else if (resp.stop_reason === 'max_tokens') {
  outcome = { status: 'needs_review', reasons: ['Model output was cut off (max_tokens)'] };
  extraction = block.input;
} else {
  extraction = block.input;
  outcome = validateExtraction(extraction, ctx.text);
}

return [{
  json: {
    idempotencyKey: ctx.idempotencyKey,
    fileName,
    status: outcome.status,
    reasons: outcome.reasons,
    extraction,
    model: resp.model || null,
    usage: resp.usage || null,
    processedAt: new Date().toISOString(),
  },
}];
`.trim();

const storeProcessed = `
const sd = $getWorkflowStaticData('global');
sd.seen = sd.seen || {};
sd.processed = sd.processed || [];
const r = $input.first().json;
sd.seen[r.idempotencyKey] = { status: r.status, at: r.processedAt };
sd.processed.push(r);
if (sd.processed.length > 200) sd.processed.shift();
return [{ json: { response: { status: 'auto_approved', idempotencyKey: r.idempotencyKey, fileName: r.fileName, extraction: r.extraction } } }];
`.trim();

const queueReview = `
const sd = $getWorkflowStaticData('global');
sd.seen = sd.seen || {};
sd.review = sd.review || [];
const r = $input.first().json;
sd.seen[r.idempotencyKey] = { status: r.status, at: r.processedAt };
sd.review.push(r);
if (sd.review.length > 200) sd.review.shift();
return [{ json: { response: { status: 'needs_review', idempotencyKey: r.idempotencyKey, fileName: r.fileName, reasons: r.reasons, extraction: r.extraction } } }];
`.trim();

const deadLetter = `
const sd = $getWorkflowStaticData('global');
sd.deadLetter = sd.deadLetter || [];
const err = $input.first().json;
const message = (err.error && (err.error.message || JSON.stringify(err.error))) || err.message || JSON.stringify(err);
// Store the failure reason and file name only. Never store document text (may contain PII/PHI).
sd.deadLetter.push({
  at: new Date().toISOString(),
  fileName: $('Intake Webhook').first().binary?.file?.fileName || 'unknown',
  error: String(message).slice(0, 500),
});
if (sd.deadLetter.length > 200) sd.deadLetter.shift();
return [{ json: { response: { status: 'error', message: 'Processing failed. The item was sent to the dead-letter queue.' } } }];
`.trim();

const buildStatus = `
const sd = $getWorkflowStaticData('global');
const seen = sd.seen || {};
return [{
  json: {
    response: {
      counts: {
        documentsSeen: Object.keys(seen).length,
        autoApproved: (sd.processed || []).length,
        needsReview: (sd.review || []).length,
        deadLetter: (sd.deadLetter || []).length,
      },
      reviewQueue: sd.review || [],
      deadLetter: sd.deadLetter || [],
      recentlyApproved: (sd.processed || []).slice(-20),
    },
  },
}];
`.trim();

const buildSheetRow = `
const r = $input.first().json.response || {};
const x = r.extraction || {};
const conf = Object.values(x.field_confidence || {}).filter((v) => typeof v === 'number');
return [{
  json: {
    'Received At': new Date().toISOString(),
    'File Name': r.fileName || '',
    'Status': r.status || '',
    'Review Reasons': (r.reasons || []).join('; '),
    'Vendor': x.vendor_name ?? '',
    'Invoice Number': x.invoice_number ?? '',
    'Invoice Date': x.invoice_date ?? '',
    'Due Date': x.due_date ?? '',
    'Currency': x.currency ?? '',
    'Subtotal': x.subtotal ?? '',
    'Tax': x.tax ?? '',
    'Total': x.total ?? '',
    'Line Items': (x.line_items || []).length,
    'Lowest Confidence': conf.length ? Math.min(...conf) : '',
    'Suspicious Content': x.suspicious_content === true ? 'TRUE' : 'FALSE',
    'Document ID': r.idempotencyKey || '',
    'Reviewed By': '',
    'Review Notes': '',
  },
}];
`.trim();

// ---------- node helpers ----------

let n = 0;
const nid = () => 'node-' + String(++n).padStart(2, '0');

const code = (name, jsCode, pos) => ({
  parameters: { jsCode },
  id: nid(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
});

const respond = (name, body, status, pos) => ({
  parameters: {
    respondWith: 'json',
    responseBody: body,
    options: { responseCode: status },
  },
  id: nid(), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: pos,
});

const ifNode = (name, left, op, right, pos) => ({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'cond-' + name.replace(/\W+/g, '-').toLowerCase(), leftValue: left, rightValue: right, operator: op }],
      combinator: 'and',
    },
    options: {},
  },
  id: nid(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
});

// ---------- nodes ----------

const nodes = [];

nodes.push({
  parameters: { httpMethod: 'POST', path: 'intake', responseMode: 'responseNode', options: {} },
  id: nid(), name: 'Intake Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2,
  position: [0, 200], webhookId: 'a1c4e8f2-6b1d-4a57-9c3e-0d2f7b5a1e01',
});

nodes.push({
  parameters: { operation: 'pdf', binaryPropertyName: 'file', options: {} },
  id: nid(), name: 'Extract PDF Text', type: 'n8n-nodes-base.extractFromFile', typeVersion: 1,
  position: [240, 200], onError: 'continueErrorOutput',
});

nodes.push({
  parameters: { action: 'hash', type: 'SHA256', value: '={{ $json.text }}', dataPropertyName: 'idempotencyKey', encoding: 'hex' },
  id: nid(), name: 'Hash Document', type: 'n8n-nodes-base.crypto', typeVersion: 1, position: [480, 120],
});

nodes.push(code('Check Duplicate', checkDuplicate, [720, 120]));

nodes.push(ifNode('Is Duplicate?', '={{ $json.duplicate }}',
  { type: 'boolean', operation: 'true', singleValue: true }, '', [960, 120]));

nodes.push(respond('Respond Duplicate',
  "={{ { status: 'duplicate', idempotencyKey: $json.idempotencyKey, priorResult: $json.priorResult } }}", 200, [1200, 40]));

nodes.push(code('Build Claude Request', buildClaudeRequest, [1200, 200]));

const claudeParams = {
  method: 'POST',
  url: mockUrl || 'https://api.anthropic.com/v1/messages',
  authentication: mockUrl ? 'none' : 'genericCredentialType',
  sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.claudeRequest) }}',
  options: { timeout: 60000 },
};
if (!mockUrl) claudeParams.genericAuthType = 'httpHeaderAuth';

const claudeNode = {
  parameters: claudeParams,
  id: nid(), name: 'Claude Extract', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  position: [1440, 200], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
  onError: 'continueErrorOutput',
};
if (!mockUrl) {
  claudeNode.credentials = { httpHeaderAuth: { id: 'REPLACE_ME', name: 'Anthropic API Key' } };
}
nodes.push(claudeNode);

nodes.push(code('Validate Extraction', validateNode, [1680, 120]));

nodes.push(ifNode('Auto-Approved?', '={{ $json.status }}',
  { type: 'string', operation: 'equals' }, 'auto_approved', [1920, 120]));

nodes.push(code('Store Processed', storeProcessed, [2160, 40]));
nodes.push(respond('Respond Approved', '={{ $json.response }}', 200, [2400, 40]));

nodes.push(code('Queue for Review', queueReview, [2160, 220]));
nodes.push(respond('Respond Needs Review', '={{ $json.response }}', 202, [2400, 220]));

nodes.push(code('Dead Letter', deadLetter, [1680, 420]));
nodes.push(respond('Respond Error', '={{ $json.response }}', 502, [1920, 420]));

nodes.push({
  parameters: { httpMethod: 'GET', path: 'queue', responseMode: 'responseNode', options: {} },
  id: nid(), name: 'Queue Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2,
  position: [0, 640], webhookId: 'a1c4e8f2-6b1d-4a57-9c3e-0d2f7b5a1e02',
});
nodes.push(code('Build Status', buildStatus, [240, 640]));
nodes.push(respond('Respond Status', '={{ $json.response }}', 200, [480, 640]));

// Optional audit log: appends every processed/queued document to a Google Sheet.
// Skipped in the mock-test variant. Set the sheet ID after import (or via --sheet-id).
const sheetId = argVal('--sheet-id') || 'YOUR_GOOGLE_SHEET_ID';
if (!mockUrl) {
  nodes.push(code('Build Sheet Row', buildSheetRow, [2640, 130]));
  nodes.push({
    parameters: {
      resource: 'sheet',
      operation: 'append',
      documentId: { __rl: true, value: sheetId, mode: 'id' },
      sheetName: { __rl: true, value: 'Invoices', mode: 'name' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: {},
    },
    id: nid(), name: 'Append to Invoice Log', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5,
    position: [2880, 130], onError: 'continueRegularOutput',
    credentials: { googleSheetsOAuth2Api: { id: 'REPLACE_ME', name: 'Google Sheets account' } },
  });
}

// ---------- connections ----------

const link = (to, index = 0) => ({ node: to, type: 'main', index });
const connections = {
  'Intake Webhook': { main: [[link('Extract PDF Text')]] },
  'Extract PDF Text': { main: [[link('Hash Document')], [link('Dead Letter')]] },
  'Hash Document': { main: [[link('Check Duplicate')]] },
  'Check Duplicate': { main: [[link('Is Duplicate?')]] },
  'Is Duplicate?': { main: [[link('Respond Duplicate')], [link('Build Claude Request')]] },
  'Build Claude Request': { main: [[link('Claude Extract')]] },
  'Claude Extract': { main: [[link('Validate Extraction')], [link('Dead Letter')]] },
  'Validate Extraction': { main: [[link('Auto-Approved?')]] },
  'Auto-Approved?': { main: [[link('Store Processed')], [link('Queue for Review')]] },
  'Store Processed': { main: [[link('Respond Approved')].concat(mockUrl ? [] : [link('Build Sheet Row')])] },
  'Queue for Review': { main: [[link('Respond Needs Review')].concat(mockUrl ? [] : [link('Build Sheet Row')])] },
  'Dead Letter': { main: [[link('Respond Error')]] },
  'Queue Webhook': { main: [[link('Build Status')]] },
  'Build Status': { main: [[link('Respond Status')]] },
};

if (!mockUrl) connections['Build Sheet Row'] = { main: [[link('Append to Invoice Log')]] };

const workflow = {
  id: 'docIntakeAgent01',
  name: 'Document Intake Agent' + (mockUrl ? ' (test)' : ''),
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  pinData: {},
  tags: [],
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');
console.log('Wrote ' + outFile + ' (' + nodes.length + ' nodes)');
