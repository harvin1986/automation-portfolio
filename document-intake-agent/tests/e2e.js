// End-to-end test against a running n8n (with the test variant of the workflow active)
// and the mock Claude server. Usage: node tests/e2e.js [n8nBase] [mockBase]
const fs = require('fs');
const path = require('path');

const N8N = process.argv[2] || 'http://localhost:5678';
const MOCK = process.argv[3] || 'http://localhost:9999';
const samples = path.join(__dirname, '..', 'samples');

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + detail));
  if (!cond) failed++;
}

async function submit(file) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(samples, file))], { type: 'application/pdf' }), file);
  const res = await fetch(N8N + '/webhook/intake', { method: 'POST', body: form });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { code: res.status, json };
}

(async () => {
  let r = await submit('invoice-clean.pdf');
  check('clean invoice is auto-approved (200)', r.code === 200 && r.json && r.json.status === 'auto_approved', JSON.stringify(r));
  check('clean invoice extraction returned', r.json && r.json.extraction && r.json.extraction.total === 615.25, JSON.stringify(r.json));

  r = await submit('invoice-clean.pdf');
  check('same file again is detected as duplicate (200)', r.code === 200 && r.json && r.json.status === 'duplicate', JSON.stringify(r));

  r = await submit('invoice-bad-totals.pdf');
  check('mismatched totals go to review (202)', r.code === 202 && r.json && r.json.status === 'needs_review', JSON.stringify(r));
  check('review reason names the math error', r.json && (r.json.reasons || []).some((s) => s.includes('total is 725')), JSON.stringify(r.json));

  r = await submit('invoice-injection.pdf');
  check('injection text goes to review even when model output looks perfect (202)', r.code === 202 && r.json && r.json.status === 'needs_review', JSON.stringify(r));
  check('review reason mentions prompt injection', r.json && (r.json.reasons || []).some((s) => s.includes('prompt-injection')), JSON.stringify(r.json));

  r = await submit('not-an-invoice.pdf');
  check('non-invoice goes to review (202)', r.code === 202 && r.json && r.json.status === 'needs_review', JSON.stringify(r));

  // Retry behaviour: 2 failures then success. The workflow retries up to 3 times.
  await fetch(MOCK + '/__fail?n=2', { method: 'POST' });
  const before = (await (await fetch(MOCK + '/__calls')).json()).calls;
  // Use a fresh document so it is not deduped: reuse bad-totals under a new name is still same text, so
  // instead rely on a unique file generated here.
  const { execFileSync } = require('child_process');
  const tmp = path.join(__dirname, '..', 'samples', '_retry-test.pdf');
  execFileSync('python3', ['-c', `
from reportlab.pdfgen import canvas
c = canvas.Canvas(${JSON.stringify(tmp)})
c.drawString(60, 700, "Northwind Supply Co INV-1001 retry variant " + "${Date.now()}")
c.save()
`]);
  r = await submit('_retry-test.pdf');
  const after = (await (await fetch(MOCK + '/__calls')).json()).calls;
  check('transient API failures are retried and then succeed (3 calls, 200)', after - before === 3 && r.code === 200 && r.json && r.json.status === 'auto_approved', 'calls ' + (after - before) + ' ' + JSON.stringify(r));

  // Dead letter: more failures than retries.
  await fetch(MOCK + '/__fail?n=10', { method: 'POST' });
  execFileSync('python3', ['-c', `
from reportlab.pdfgen import canvas
c = canvas.Canvas(${JSON.stringify(tmp)})
c.drawString(60, 700, "Northwind Supply Co INV-1001 deadletter variant " + "${Date.now()}")
c.save()
`]);
  r = await submit('_retry-test.pdf');
  check('persistent API failure returns 502 and goes to dead letter', r.code === 502 && r.json && r.json.status === 'error', JSON.stringify(r));
  await fetch(MOCK + '/__fail?n=0', { method: 'POST' });

  // Corrupt PDF -> extraction failure -> dead letter
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('this is not a pdf')], { type: 'application/pdf' }), 'corrupt.pdf');
  const res = await fetch(N8N + '/webhook/intake', { method: 'POST', body: form });
  check('corrupt PDF returns 502 (dead letter), not a hang or crash', res.status === 502, 'status ' + res.status);

  const status = await (await fetch(N8N + '/webhook/queue')).json();
  console.log('\nQueue status:', JSON.stringify(status.counts));
  check('queue endpoint: 2 auto-approved (clean + retried)', status.counts.autoApproved === 2, JSON.stringify(status.counts));
  check('queue endpoint: review queue has the 3 flagged documents', status.counts.needsReview === 3, JSON.stringify(status.counts));
  check('queue endpoint: dead letter has 2 entries', status.counts.deadLetter === 2, JSON.stringify(status.counts));
  check('dead letter stores no document text', status.deadLetter.every((d) => !('text' in d) && !JSON.stringify(d).includes('Northwind')), JSON.stringify(status.deadLetter));

  fs.rmSync(tmp, { force: true });
  console.log(failed === 0 ? '\nAll checks passed' : '\n' + failed + ' check(s) FAILED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
