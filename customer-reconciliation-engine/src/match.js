// Record matching: cached links, then deterministic keys, then blocked fuzzy scoring.
const { normName, normEmail, normPhone, normPostal, jaroWinkler } = require("./strings");
// Needs strings.js inlined above it in n8n.

const HIGH = 0.85;      // fuzzy score that can auto-link, together with 3+ corroborating signals
const MIN_STRONG = 3;
const AMBIGUOUS = 0.7;  // below this a pair is not even a candidate

function prep(r, sys) {
  return sys === 'crm'
    ? { id: r.id, name: normName(r.full_name), email: normEmail(r.email), phone: normPhone(r.phone), postal: normPostal(r.postal_code), fk: r.billing_id || null }
    : { id: r.id, name: normName(r.name), email: normEmail(r.email), phone: normPhone(r.phone), postal: normPostal(r.postal), fk: null };
}

function scorePair(a, b) {
  const nameSim = jaroWinkler(a.name, b.name);
  const postal = a.postal && a.postal === b.postal ? 1 : 0;
  const phone = a.phone && a.phone === b.phone ? 1 : 0;
  const la = a.email.split('@')[0], lb = b.email.split('@')[0];
  const emailSim = la && lb ? jaroWinkler(la, lb) : 0;
  const score = 0.55 * nameSim + 0.15 * postal + 0.2 * phone + 0.1 * emailSim;
  const strong = (nameSim >= 0.9 ? 1 : 0) + postal + phone + (emailSim >= 0.85 ? 1 : 0);
  return { score: Math.round(score * 1000) / 1000, nameSim, postal, phone, emailSim, strong };
}

function addTo(map, key, id) { if (!key) return; (map[key] = map[key] || []).push(id); }

// links: { crm_id: { billing_id } } cached confirmed matches. rejected: { 'crm|billing': true }.
function matchRecords(crmRaw, billRaw, links, rejected) {
  links = links || {}; rejected = rejected || {};
  const crm = crmRaw.map((r) => prep(r, 'crm'));
  const bill = billRaw.map((r) => prep(r, 'billing'));
  const billById = Object.fromEntries(bill.map((b) => [b.id, b]));
  const byEmail = {}, byPhonePostal = {};
  for (const b of bill) { addTo(byEmail, b.email, b.id); if (b.phone && b.postal) addTo(byPhonePostal, b.phone + '|' + b.postal, b.id); }

  const claims = {};      // billing_id -> [{crm_id, method}]
  const conflicts = [];
  const pending = [];     // crm records still needing fuzzy matching
  for (const c of crm) {
    let hit = null; let multi = null;
    const cached = links[c.id] && links[c.id].billing_id;
    if (cached && billById[cached]) hit = { id: cached, method: 'cached' };
    else if (c.fk && billById[c.fk]) hit = { id: c.fk, method: 'foreign_key' };
    else {
      for (const [method, ids] of [['email', byEmail[c.email]], ['phone_postal', c.phone && c.postal ? byPhonePostal[c.phone + '|' + c.postal] : null]]) {
        if (ids && ids.length === 1) { hit = { id: ids[0], method }; break; }
        if (ids && ids.length > 1) { multi = { method, ids }; break; }
      }
    }
    if (multi) conflicts.push({ type: 'multiple_billing_candidates', crm_id: c.id, billing_ids: multi.ids, method: multi.method });
    else if (hit) addTo(claims, hit.id, { crm_id: c.id, method: hit.method });
    else pending.push(c);
  }

  const matched = [];
  const claimedBilling = new Set();
  const conflictedCrm = new Set(conflicts.map((x) => x.crm_id));
  for (const [billingId, list] of Object.entries(claims)) {
    if (list.length > 1) {
      conflicts.push({ type: 'duplicate_claim', billing_id: billingId, crm_ids: list.map((x) => x.crm_id) });
      list.forEach((x) => conflictedCrm.add(x.crm_id));
      claimedBilling.add(billingId);
    } else {
      matched.push({ crm_id: list[0].crm_id, billing_id: billingId, method: list[0].method, score: 1 });
      claimedBilling.add(billingId);
    }
  }

  // Fuzzy pass over what is left. Blocking keeps this far below N x M comparisons.
  const freeBill = bill.filter((b) => !claimedBilling.has(b.id));
  const blocks = {};
  for (const b of freeBill) { addTo(blocks, 'p:' + b.postal, b.id); addTo(blocks, 't:' + b.phone, b.id); addTo(blocks, 'n:' + b.name.slice(0, 3), b.id); }
  const candidates = [];
  for (const c of pending) {
    const ids = new Set([...(blocks['p:' + c.postal] || []), ...(blocks['t:' + c.phone] || []), ...(blocks['n:' + c.name.slice(0, 3)] || [])]);
    for (const id of ids) {
      if (rejected[c.id + '|' + id]) continue;
      const s = scorePair(c, billById[id]);
      if (s.score >= AMBIGUOUS) candidates.push({ crm_id: c.id, billing_id: id, ...s });
    }
  }
  candidates.sort((x, y) => y.score - x.score || (x.crm_id + x.billing_id < y.crm_id + y.billing_id ? -1 : 1));
  const usedCrm = new Set(), usedBill = new Set(), ambiguous = [];
  for (const k of candidates) {
    if (usedCrm.has(k.crm_id) || usedBill.has(k.billing_id)) continue;
    usedCrm.add(k.crm_id); usedBill.add(k.billing_id);
    if (k.score >= HIGH && k.strong >= MIN_STRONG) matched.push({ crm_id: k.crm_id, billing_id: k.billing_id, method: 'fuzzy_high', score: k.score });
    else ambiguous.push({ crm_id: k.crm_id, billing_id: k.billing_id, score: k.score, signals: { nameSim: Math.round(k.nameSim * 100) / 100, postal: k.postal, phone: k.phone, emailSim: Math.round(k.emailSim * 100) / 100 } });
  }

  const matchedCrm = new Set(matched.map((m) => m.crm_id));
  const matchedBill = new Set(matched.map((m) => m.billing_id));
  const ambCrm = new Set(ambiguous.map((a) => a.crm_id));
  const ambBill = new Set(ambiguous.map((a) => a.billing_id));
  const confBill = new Set(conflicts.flatMap((x) => x.billing_ids || (x.billing_id ? [x.billing_id] : [])));
  return {
    matched, ambiguous, conflicts,
    unmatchedCrm: crm.filter((c) => !matchedCrm.has(c.id) && !ambCrm.has(c.id) && !conflictedCrm.has(c.id)).map((c) => c.id),
    orphanBilling: bill.filter((b) => !matchedBill.has(b.id) && !ambBill.has(b.id) && !confBill.has(b.id)).map((b) => b.id),
  };
}

// --- exports (dropped when inlined into n8n) ---
module.exports = { matchRecords, scorePair, prep, HIGH, AMBIGUOUS };
