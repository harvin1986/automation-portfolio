// Field-level diff with per-field source of truth, plus the blast-radius guard.
const { sha256, toHex, utf8 } = require("./hmac"); const { normName, normEmail, normPhone, normPostal } = require("./strings");
// Needs hmac.js and strings.js inlined above it in n8n.

// Which system owns which field. The owner's value overwrites the other system's.
const CRM_OWNS = [
  { crm: 'full_name', bill: 'name', same: (a, b) => normName(a) === normName(b) },
  { crm: 'email', bill: 'email', same: (a, b) => normEmail(a) === normEmail(b) },
  { crm: 'phone', bill: 'phone', same: (a, b) => normPhone(a) === normPhone(b) },
  { crm: 'postal_code', bill: 'postal', same: (a, b) => normPostal(a) === normPostal(b) },
];
const BILLING_OWNS = [
  { crm: 'plan', bill: 'plan', same: (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() },
  { crm: 'status', bill: 'status', same: (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() },
];

const BILLING_BASE = 'https://billing.example.invalid/api/accounts/';
const CRM_BASE = 'https://crm.example.invalid/api/contacts/';
const GUARD_RATIO = 0.2;   // refuse to apply if more than 20% of matched records would change
const GUARD_MIN = 10;      // ...but always allow at least this many

const blank = (v) => v == null || String(v).trim() === '';

function stable(o) { return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); }

function makeAction(target, recordId, patch, reason) {
  const key = toHex(sha256(utf8(target + '|' + recordId + '|' + stable(patch))));
  return {
    target, record_id: recordId, patch, reason, idempotency_key: key, method: 'PATCH',
    url: (target === 'billing' ? BILLING_BASE : CRM_BASE) + encodeURIComponent(recordId),
  };
}

function planActions(matched, crmById, billById) {
  const actions = []; const skippedBlank = [];
  for (const m of matched) {
    const c = crmById[m.crm_id], b = billById[m.billing_id];
    if (!c || !b) continue;
    const toBilling = {}, toCrm = {};
    for (const f of CRM_OWNS) {
      if (f.same(c[f.crm], b[f.bill])) continue;
      if (blank(c[f.crm])) { skippedBlank.push({ crm_id: c.id, field: f.crm }); continue; } // never wipe data with an empty value
      toBilling[f.bill] = c[f.crm];
    }
    for (const f of BILLING_OWNS) {
      if (f.same(c[f.crm], b[f.bill])) continue;
      if (blank(b[f.bill])) { skippedBlank.push({ billing_id: b.id, field: f.bill }); continue; }
      toCrm[f.crm] = b[f.bill];
    }
    if (c.billing_id !== b.id) toCrm.billing_id = b.id; // backfill the link
    if (Object.keys(toBilling).length) actions.push(makeAction('billing', b.id, toBilling, 'crm_owns:' + Object.keys(toBilling).join(',')));
    if (Object.keys(toCrm).length) actions.push(makeAction('crm', c.id, toCrm, 'billing_owns:' + Object.keys(toCrm).join(',')));
  }
  return { actions, skippedBlank };
}

function guardLimit(matchedCount) { return Math.max(GUARD_MIN, Math.ceil(GUARD_RATIO * matchedCount)); }

// --- exports (dropped when inlined into n8n) ---
module.exports = { planActions, guardLimit, makeAction, GUARD_RATIO, GUARD_MIN };
