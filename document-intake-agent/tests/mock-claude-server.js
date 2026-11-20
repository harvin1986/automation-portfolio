// Minimal stand-in for the Anthropic Messages API, used only for local end-to-end tests.
// It returns canned tool_use responses based on the document text, so it tests the
// workflow plumbing (routing, retries, dedupe, queues), NOT Claude's extraction accuracy.
//
//   node tests/mock-claude-server.js [port]
//   POST /__fail?n=3   -> the next 3 calls to /v1/messages return HTTP 500

const http = require('http');
const port = Number(process.argv[2] || 9999);
let failuresLeft = 0;
let calls = 0;

const conf = (v) => ({ vendor_name: v, invoice_number: v, invoice_date: v, total: v });

function cannedFor(text) {
  if (text.includes('INV-1001')) {
    return {
      document_type: 'invoice', vendor_name: 'Northwind Supply Co', invoice_number: 'INV-1001',
      invoice_date: '2026-10-01', due_date: '2026-10-31', currency: 'USD', subtotal: 575, tax: 40.25, total: 615.25,
      line_items: [
        { description: 'Warehouse shelving unit', quantity: 4, unit_price: 125, amount: 500 },
        { description: 'Delivery and setup', quantity: 1, unit_price: 75, amount: 75 },
      ],
      field_confidence: conf(0.98), suspicious_content: false,
    };
  }
  if (text.includes('INV-1002')) {
    return {
      document_type: 'invoice', vendor_name: 'Harbor Light Services', invoice_number: 'INV-1002',
      invoice_date: '2026-10-05', due_date: '2026-11-04', currency: 'USD', subtotal: 575, tax: 0, total: 725,
      line_items: [
        { description: 'Monthly IT support', quantity: 1, unit_price: 400, amount: 400 },
        { description: 'After-hours call-out', quantity: 1, unit_price: 175, amount: 175 },
      ],
      field_confidence: conf(0.97), suspicious_content: false,
    };
  }
  if (text.includes('INV-1003')) {
    // Simulates a model that was fooled by the injected text: perfect numbers, full confidence,
    // no suspicious flag. The deterministic pattern check in the workflow must still catch it.
    return {
      document_type: 'invoice', vendor_name: 'Bluebird Office Goods', invoice_number: 'INV-1003',
      invoice_date: '2026-10-09', due_date: '2026-11-08', currency: 'USD', subtotal: 420, tax: 29.4, total: 449.4,
      line_items: [{ description: 'Printer paper (case)', quantity: 10, unit_price: 42, amount: 420 }],
      field_confidence: conf(1.0), suspicious_content: false,
    };
  }
  return {
    document_type: 'other', vendor_name: null, invoice_number: null, invoice_date: null, due_date: null,
    currency: null, subtotal: null, tax: null, total: null, line_items: [],
    field_confidence: conf(0.9), suspicious_content: false,
  };
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/__fail')) {
    failuresLeft = Number(new URL(req.url, 'http://x').searchParams.get('n') || 1);
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && req.url === '/__calls') {
    res.end(JSON.stringify({ calls }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    if (failuresLeft > 0) {
      failuresLeft--;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock failure' } }));
      return;
    }
    const parsed = JSON.parse(body);
    const text = parsed.messages[0].content;
    const out = {
      id: 'msg_mock', type: 'message', role: 'assistant', model: parsed.model,
      stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'tool_use', id: 'toolu_mock', name: 'record_invoice', input: cannedFor(text) }],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(port, () => console.log('mock Claude listening on ' + port));
