// Normalizers and string similarity. Comparing normalized values prevents churn from formatting
// differences ("(410) 555-0101" vs "410-555-0101") that are not real data differences.

function normName(s) {
  let t = String(s == null ? '' : s);
  if (t.includes(',')) { const [last, first] = t.split(','); t = (first || '') + ' ' + last; } // "Smith, John"
  return t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\b(mr|mrs|ms|dr|jr|sr|ii|iii)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function normEmail(s) {
  const t = String(s == null ? '' : s).trim().toLowerCase();
  const at = t.lastIndexOf('@');
  if (at < 1) return '';
  let local = t.slice(0, at).split('+')[0];
  const domain = t.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

function normPhone(s) {
  let d = String(s == null ? '' : s).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : d.length >= 7 ? d : '';
}

function normPostal(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); }

function jaroWinkler(a, b) {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) { if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; } }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && p < a.length && p < b.length && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

// --- exports (dropped when inlined into n8n) ---
module.exports = { normName, normEmail, normPhone, normPostal, jaroWinkler };
