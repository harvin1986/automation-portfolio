// Removes common personal identifiers before text is sent to the LLM.
// Pattern-based, so it is a first line of defense, not a guarantee.

function luhnValid(digits) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function redactPII(input) {
  let text = String(input == null ? '' : input);
  const counts = {};
  const hit = (k) => { counts[k] = (counts[k] || 0) + 1; };
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => { hit('email'); return '[EMAIL]'; });
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => { hit('ssn'); return '[SSN]'; });
  text = text.replace(/\b(?:\d[ -]?){13,16}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 16 && luhnValid(digits)) { hit('card'); return '[CARD]'; }
    return m;
  });
  text = text.replace(/\b(?:MRN|DOB|Date of birth)\s*[:#]?\s*[\w\/-]+/gi, () => { hit('identifier'); return '[ID]'; });
  text = text.replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, () => { hit('phone'); return '[PHONE]'; });
  return { text, counts };
}

function mergeCounts(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) out[k] = (out[k] || 0) + b[k];
  return out;
}

// --- exports (dropped when inlined into n8n) ---
module.exports = { redactPII, mergeCounts, luhnValid };
