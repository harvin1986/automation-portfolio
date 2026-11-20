const test = require('node:test');
const assert = require('node:assert');
const { decide, buildClaudeRequest } = require('../src/triage');
const { goodInput } = require('./helpers');

const cases = [
  ['low-risk technical, high confidence', {}, 'auto_reply'],
  ['feature request p4', { category: 'feature_request', priority: 'p4' }, 'auto_reply'],
  ['billing always needs approval', { category: 'billing' }, 'needs_approval'],
  ['account access always needs approval', { category: 'account_access' }, 'needs_approval'],
  ['low confidence', { confidence: 0.79 }, 'needs_approval'],
  ['boundary confidence 0.8 is allowed', { confidence: 0.8 }, 'auto_reply'],
  ['negative sentiment', { sentiment: 'negative' }, 'needs_approval'],
  ['p2 needs approval', { priority: 'p2' }, 'needs_approval'],
  ['model flags a commitment', { contains_commitment: true }, 'needs_approval'],
  ['reply promises a refund even if model said no', { draft_reply: 'We will refund you today.' }, 'needs_approval'],
  ['reply mentions a dollar amount', { draft_reply: 'We can offer $50 off.' }, 'needs_approval'],
  ['reply echoes a placeholder', { draft_reply: 'We emailed [EMAIL] already.' }, 'needs_approval'],
  ['p1 escalates', { priority: 'p1' }, 'escalate'],
  ['security incident escalates', { category: 'security_incident' }, 'escalate'],
  ['prompt injection flagged escalates', { suspicious_content: true }, 'escalate'],
  ['unknown category escalates', { category: 'made_up' }, 'escalate'],
  ['confidence above 1 escalates', { confidence: 1.4 }, 'escalate'],
  ['empty reply escalates', { draft_reply: '  ' }, 'escalate'],
];
for (const [name, over, expected] of cases) {
  test('policy: ' + name, () => assert.strictEqual(decide(goodInput(over)).decision, expected));
}

test('policy: missing classification escalates', () => assert.strictEqual(decide(null).decision, 'escalate'));

test('policy: escalation outranks approval reasons', () => {
  assert.strictEqual(decide(goodInput({ category: 'billing', suspicious_content: true })).decision, 'escalate');
});

test('request uses tool_choice auto and wraps ticket text as data', () => {
  const r = buildClaudeRequest('Subj', 'Body text');
  assert.deepStrictEqual(r.tool_choice, { type: 'auto' });
  assert.ok(r.messages[0].content.includes('<ticket>'));
  assert.ok(/untrusted DATA/.test(r.system));
});
