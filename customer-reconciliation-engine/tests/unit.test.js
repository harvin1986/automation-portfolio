const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const S = require('../src/strings');
const { matchRecords } = require('../src/match');
const { planActions, guardLimit } = require('../src/diff');
const A = require('../src/adjudicate');
const { sha256, toHex, utf8 } = require('../src/hmac');

test('sha256 matches Node crypto', () => {
  for (const n of [0, 1, 55, 56, 64, 1000]) assert.strictEqual(toHex(sha256(Buffer.alloc(n, 3))), crypto.createHash('sha256').update(Buffer.alloc(n, 3)).digest('hex'));
});

test('Jaro-Winkler matches published reference values', () => {
  assert.strictEqual(S.jaroWinkler('martha', 'marhta').toFixed(3), '0.961');
  assert.strictEqual(S.jaroWinkler('dixon', 'dicksonx').toFixed(3), '0.813');
  assert.strictEqual(S.jaroWinkler('abc', 'abc'), 1);
  assert.strictEqual(S.jaroWinkler('', 'abc'), 0);
});

test('normalizers', () => {
  assert.strictEqual(S.normEmail(' Bob.Smith+news@Gmail.com '), 'bobsmith@gmail.com');
  assert.strictEqual(S.normEmail('a.b@corp.com'), 'a.b@corp.com'); // dots only ignored for gmail
  assert.strictEqual(S.normEmail('not-an-email'), '');
  assert.strictEqual(S.normPhone('+1 (410) 555-0101'), '4105550101');
  assert.strictEqual(S.normPhone('12'), '');
  assert.strictEqual(S.normName('Smith, Dr. John Jr.'), 'john smith');
  assert.strictEqual(S.normName('José  Núñez'), 'jose nunez');
  assert.strictEqual(S.normPostal('21061-1234'), '21061');
});

const C = (o) => ({ id: 'c', full_name: 'X', email: '', phone: '', postal_code: '', billing_id: null, plan: 'free', status: 'active', ...o });
const B = (o) => ({ id: 'b', name: 'X', email: '', phone: '', postal: '', plan: 'free', status: 'active', ...o });

test('match: stages in priority order, cached link wins, foreign key beats email', () => {
  const crm = [C({ id: 'c1', email: 'a@x.com', billing_id: 'b2' }), C({ id: 'c2', full_name: 'Q', email: 'q@x.com' })];
  const bill = [B({ id: 'b1', email: 'a@x.com' }), B({ id: 'b2', email: 'z@x.com' }), B({ id: 'b3', name: 'Q', email: 'q@x.com' })];
  const r = matchRecords(crm, bill, {}, {});
  assert.deepStrictEqual(r.matched.map((m) => [m.crm_id, m.billing_id, m.method]).sort(), [['c1', 'b2', 'foreign_key'], ['c2', 'b3', 'email']]);
  const cached = matchRecords(crm, bill, { c1: { billing_id: 'b1' } }, {});
  assert.strictEqual(cached.matched.find((m) => m.crm_id === 'c1').billing_id, 'b1');
  assert.strictEqual(cached.matched.find((m) => m.crm_id === 'c1').method, 'cached');
});

test('match: a stale cached link to a deleted billing record is ignored', () => {
  const r = matchRecords([C({ id: 'c1', email: 'a@x.com' })], [B({ id: 'b1', email: 'a@x.com' })], { c1: { billing_id: 'gone' } }, {});
  assert.strictEqual(r.matched[0].billing_id, 'b1');
});

test('match: two CRM records claiming one billing record are a conflict, not a match', () => {
  const r = matchRecords([C({ id: 'c1', email: 's@x.com' }), C({ id: 'c2', email: 's@x.com' })], [B({ id: 'b1', email: 's@x.com' })], {}, {});
  assert.strictEqual(r.matched.length, 0);
  assert.strictEqual(r.conflicts[0].type, 'duplicate_claim');
  assert.deepStrictEqual(r.unmatchedCrm, []);
  assert.deepStrictEqual(r.orphanBilling, []);
});

test('match: one CRM record with two billing candidates is a conflict', () => {
  const r = matchRecords([C({ id: 'c1', email: 's@x.com' })], [B({ id: 'b1', email: 's@x.com' }), B({ id: 'b2', email: 's@x.com' })], {}, {});
  assert.strictEqual(r.conflicts[0].type, 'multiple_billing_candidates');
  assert.strictEqual(r.matched.length, 0);
});

test('match: rejected pairs are never proposed again; low scores are unmatched', () => {
  const crm = [C({ id: 'c1', full_name: 'Katherine Lee', email: 'klee@x.com', phone: '4105550104' })];
  const bill = [B({ id: 'b1', name: 'Catherine Lee', email: 'klee@y.com', phone: '4105550104', postal: '21401' })];
  assert.strictEqual(matchRecords(crm, bill, {}, {}).ambiguous.length, 1);
  const r = matchRecords(crm, bill, {}, { 'c1|b1': true });
  assert.strictEqual(r.ambiguous.length, 0);
  assert.deepStrictEqual(r.unmatchedCrm, ['c1']);
  const far = matchRecords([C({ id: 'c1', full_name: 'Alice' })], [B({ id: 'b1', name: 'Zhang Wei' })], {}, {});
  assert.deepStrictEqual(far.unmatchedCrm, ['c1']);
  assert.deepStrictEqual(far.orphanBilling, ['b1']);
});

test('match: high fuzzy score with corroboration auto-links; name alone does not', () => {
  const hi = matchRecords([C({ id: 'c1', full_name: 'Maria Garcia', email: 'mgarcia@a.com', phone: '4105550111', postal_code: '21001' })],
    [B({ id: 'b1', name: 'Maria Garcia', email: 'mgarcia@b.com', phone: '4105550111', postal: '21777' })], {}, {});
  assert.strictEqual(hi.matched[0].method, 'fuzzy_high');
  const nameOnly = matchRecords([C({ id: 'c1', full_name: 'Maria Garcia' })], [B({ id: 'b1', name: 'Maria Garcia' })], {}, {});
  assert.strictEqual(nameOnly.matched.length, 0);
});

const idx = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('diff: field ownership, formatting-only differences produce no action, link backfill', () => {
  const c = C({ id: 'c1', full_name: 'Ann Lee', email: 'ann@x.com', phone: '(410) 555-0101', postal_code: '21061', billing_id: null, plan: 'free' });
  const b = B({ id: 'b1', name: 'Ann Lee', email: 'ann@x.com', phone: '410-555-0101', postal: '21061', plan: 'pro' });
  const { actions } = planActions([{ crm_id: 'c1', billing_id: 'b1' }], idx([c]), idx([b]));
  assert.strictEqual(actions.length, 1);
  assert.deepStrictEqual(actions[0].patch, { plan: 'pro', billing_id: 'b1' });
  assert.strictEqual(actions[0].target, 'crm');
  const c2 = { ...c, full_name: 'Ann Smith', billing_id: 'b1', plan: 'pro' };
  const r2 = planActions([{ crm_id: 'c1', billing_id: 'b1' }], idx([c2]), idx([b]));
  assert.deepStrictEqual(r2.actions.map((a) => [a.target, a.patch]), [['billing', { name: 'Ann Smith' }]]);
});

test('diff: an empty source value never overwrites data', () => {
  const c = C({ id: 'c1', full_name: 'Ann', phone: '', billing_id: 'b1' });
  const b = B({ id: 'b1', name: 'Ann', phone: '410-555-0101', plan: 'free' });
  const r = planActions([{ crm_id: 'c1', billing_id: 'b1' }], idx([c]), idx([b]));
  assert.strictEqual(r.actions.length, 0);
  assert.strictEqual(r.skippedBlank.length, 1);
});

test('diff: idempotency keys are deterministic and change with the patch', () => {
  const c = C({ id: 'c1', full_name: 'Ann Smith', billing_id: 'b1' });
  const b = B({ id: 'b1', name: 'Ann Lee' });
  const k1 = planActions([{ crm_id: 'c1', billing_id: 'b1' }], idx([c]), idx([b])).actions[0].idempotency_key;
  const k2 = planActions([{ crm_id: 'c1', billing_id: 'b1' }], idx([c]), idx([b])).actions[0].idempotency_key;
  const k3 = planActions([{ crm_id: 'c1', billing_id: 'b1' }], idx([{ ...c, full_name: 'Ann Jones' }]), idx([b])).actions[0].idempotency_key;
  assert.strictEqual(k1, k2); assert.notStrictEqual(k1, k3); assert.strictEqual(k1.length, 64);
});

test('guard limit: at least 10, else 20% of matched', () => {
  assert.strictEqual(guardLimit(5), 10); assert.strictEqual(guardLimit(100), 20); assert.strictEqual(guardLimit(1000), 200);
});

test('adjudication request minimizes personal data', () => {
  const c = C({ id: 'c1', full_name: 'Ann Lee', email: 'ann.lee@secret-corp.com', phone: '(410) 555-0101', postal_code: '21061' });
  const b = B({ id: 'b1', name: 'Anne Lee', email: 'alee@other.org', phone: '410-555-0199', postal: '21061' });
  const { request } = A.buildAdjudicationRequest([{ crm_id: 'c1', billing_id: 'b1', score: 0.8 }], idx([c]), idx([b]));
  const s = JSON.stringify(request);
  assert.ok(!/ann\.lee@|alee@|555-0101|410-555/.test(s));
  assert.ok(s.includes('secret-corp.com') && s.includes('0101') && s.includes('Ann Lee'));
  assert.deepStrictEqual(request.tool_choice, { type: 'auto' });
});

test('adjudication policy: model alone can never link; unknown, duplicate and malformed decisions are ignored', () => {
  const amb = [{ crm_id: 'c1', billing_id: 'b1', score: 0.85 }, { crm_id: 'c2', billing_id: 'b2', score: 0.72 }, { crm_id: 'c3', billing_id: 'b3', score: 0.85 }, { crm_id: 'c4', billing_id: 'b4', score: 0.85 }, { crm_id: 'c5', billing_id: 'b5', score: 0.85 }];
  const map = { p1: { crm_id: 'c1', billing_id: 'b1' }, p2: { crm_id: 'c2', billing_id: 'b2' }, p3: { crm_id: 'c3', billing_id: 'b3' }, p4: { crm_id: 'c4', billing_id: 'b4' }, p5: { crm_id: 'c5', billing_id: 'b5' } };
  const r = A.resolveAmbiguous(amb, map, { decisions: [
    { pair_id: 'p1', same_entity: true, confidence: 0.95 },   // link
    { pair_id: 'p2', same_entity: true, confidence: 0.99 },   // rule score too low -> review
    { pair_id: 'p3', same_entity: false, confidence: 0.9 },   // reject
    { pair_id: 'p4', same_entity: true, confidence: 0.6 },    // not confident -> review
    { pair_id: 'p4', same_entity: true, confidence: 0.99 },   // duplicate id -> ignored, review
    { pair_id: 'p99', same_entity: true, confidence: 1 },     // invented id
    { pair_id: 'p5', same_entity: 'yes', confidence: 2 },     // malformed -> review
  ] });
  assert.deepStrictEqual(r.link.map((x) => x.crm_id), ['c1']);
  assert.deepStrictEqual(r.reject.map((x) => x.crm_id), ['c3']);
  assert.deepStrictEqual(r.review.map((x) => x.crm_id).sort(), ['c2', 'c4', 'c5']);
  assert.strictEqual(A.resolveAmbiguous(amb, map, null).review.length, 5);
});
