// Validation rules for extracted invoice data.
// Plain functions only: the build script inlines this file into an n8n Code node,
// and the tests require() it. Everything below the exports marker is dropped on inline.

const REQUIRED_FIELDS = ['vendor_name', 'invoice_number', 'invoice_date', 'total'];

const INJECTION_PATTERNS = [
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|rules)/i,
  /disregard (all |any )?(the )?(previous|prior|above)/i,
  /system prompt/i,
  /you are now/i,
  /mark (this|it) as (approved|auto[-_ ]?approved)/i,
  /set (the )?(confidence|status)/i,
];

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function close(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function validateExtraction(x, rawText, opts) {
  const o = Object.assign({ minConfidence: 0.85, tolerance: 0.02 }, opts || {});
  const reasons = [];

  if (!x || typeof x !== 'object') {
    return { status: 'needs_review', reasons: ['No structured output from model'] };
  }

  if (x.document_type !== 'invoice') {
    reasons.push('Document type is "' + x.document_type + '", not an invoice');
  }

  for (const f of REQUIRED_FIELDS) {
    if (x[f] === null || x[f] === undefined || x[f] === '') {
      reasons.push('Missing required field: ' + f);
    }
  }

  if (x.invoice_date && !isIsoDate(x.invoice_date)) reasons.push('invoice_date is not YYYY-MM-DD');
  if (x.due_date && !isIsoDate(x.due_date)) reasons.push('due_date is not YYYY-MM-DD');
  if (isIsoDate(x.invoice_date) && isIsoDate(x.due_date) && x.due_date < x.invoice_date) {
    reasons.push('due_date is before invoice_date');
  }

  if (x.currency && !/^[A-Z]{3}$/.test(x.currency)) reasons.push('currency is not a 3-letter code');

  for (const f of ['subtotal', 'tax', 'total']) {
    if (x[f] !== null && x[f] !== undefined && !isNum(x[f])) reasons.push(f + ' is not a number');
  }
  if (isNum(x.total) && x.total < 0) reasons.push('total is negative');

  const items = Array.isArray(x.line_items) ? x.line_items : [];
  if (items.length === 0) reasons.push('No line items extracted');
  let itemSum = 0;
  let itemSumValid = items.length > 0;
  items.forEach(function (li, i) {
    if (!isNum(li.amount)) {
      reasons.push('Line item ' + (i + 1) + ' has no numeric amount');
      itemSumValid = false;
      return;
    }
    itemSum += li.amount;
    if (isNum(li.quantity) && isNum(li.unit_price) && !close(li.quantity * li.unit_price, li.amount, o.tolerance)) {
      reasons.push('Line item ' + (i + 1) + ': quantity x unit_price does not equal amount');
    }
  });

  if (itemSumValid && isNum(x.subtotal) && !close(itemSum, x.subtotal, o.tolerance)) {
    reasons.push('Line items sum to ' + itemSum.toFixed(2) + ' but subtotal is ' + x.subtotal);
  }
  if (isNum(x.subtotal) && isNum(x.total)) {
    const expected = x.subtotal + (isNum(x.tax) ? x.tax : 0);
    if (!close(expected, x.total, o.tolerance)) {
      reasons.push('subtotal + tax is ' + expected.toFixed(2) + ' but total is ' + x.total);
    }
  }

  const conf = x.field_confidence || {};
  for (const f of REQUIRED_FIELDS) {
    const c = conf[f];
    if (!isNum(c)) reasons.push('No confidence score for ' + f);
    else if (c < o.minConfidence) reasons.push('Low confidence on ' + f + ' (' + c + ')');
  }

  if (x.suspicious_content === true) reasons.push('Model flagged instruction-like text inside the document');
  if (typeof rawText === 'string') {
    for (const p of INJECTION_PATTERNS) {
      if (p.test(rawText)) {
        reasons.push('Document text matches prompt-injection pattern: ' + p.source);
        break;
      }
    }
  }

  return { status: reasons.length === 0 ? 'auto_approved' : 'needs_review', reasons: reasons };
}

// --- exports (dropped when inlined into n8n) ---
module.exports = { validateExtraction, REQUIRED_FIELDS, INJECTION_PATTERNS };
