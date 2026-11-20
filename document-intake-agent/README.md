# Document Intake Agent (n8n + Claude)

An n8n workflow that takes a PDF invoice, extracts structured data with Claude, **checks the result with deterministic rules**, and routes it: auto-approve, human review queue, or dead letter. It is built to show how to use an LLM in a business process without trusting it blindly.

**The business problem:** someone retypes invoice data by hand, and errors slip through. A plain "send it to an AI" workflow fixes the typing but creates a new risk: wrong numbers that look right. This workflow only auto-approves documents that pass independent checks, and sends everything else to a person with the reasons attached.

## How it works

```
POST /webhook/intake (PDF)
  -> Extract PDF text ------------------------------(fails)--> Dead Letter -> 502
  -> Hash text (SHA-256) = idempotency key
  -> Seen before? --yes--> return the earlier result (200, status "duplicate")
  -> Build Claude request (tool use, JSON schema)
  -> Claude Extract (3 tries, 60s timeout) ---------(fails)--> Dead Letter -> 502
  -> Validate (math, dates, required fields, confidence, injection patterns)
  -> passes?  yes -> Store processed -> 200 "auto_approved"
              no  -> Review queue    -> 202 "needs_review" + reasons
  (both paths) -> Append a row to the Google Sheet audit log (optional)

GET /webhook/queue -> counts, review queue, dead letter, recent approvals
```

## Design decisions

- **Idempotency:** the key is a SHA-256 hash of the document text, so resubmitting the same file returns the earlier result instead of processing (and paying for) it again. A key is recorded only after a document is processed or queued, so a failed attempt can be retried.
- **Failure handling:** the Claude call retries 3 times with a 2 second wait and a 60 second timeout. If it still fails, or the PDF cannot be read, the item goes to a dead-letter list and the caller gets a clear 502. Nothing disappears silently.
- **Validation:** the model's output is treated as untrusted. Code checks required fields, date formats, `quantity x unit price = amount`, line items sum to subtotal, `subtotal + tax = total`, and per-field confidence (threshold 0.85). Any failure routes to review with a plain-English reason.
- **Prompt injection:** the prompt tells the model the document is data, and the model can flag instruction-like text. As a backstop, a regex check in code forces review when the document text contains phrases like "ignore all previous instructions", even if the model reports everything as fine. The test suite simulates a fooled model to prove this.
- **Structured output:** tool use with a JSON schema, so the model returns data in a fixed shape, not free text. `tool_choice` is `auto` because newer models reject a forced tool choice; if the model ever skips the tool call, the validator sends the document to review instead of failing.
- **Audit log:** every processed or queued document is appended to a Google Sheet (18 columns, see `docs/invoice-log-columns.md`) so reviewers and finance have a permanent record. The log node is non-blocking: if Sheets is down, the invoice is still processed and the caller still gets a response.
- **Security and PHI/PII:** the dead-letter record stores only the file name, time, and error message, never document text. The API key lives in an n8n credential, not in the workflow file.
- **Observability:** `GET /webhook/queue` shows counts and contents of every queue. Every result includes the model name and token usage.
- **Tradeoffs I chose:**
  - Queues live in n8n workflow static data so the project runs with no database. This is fine for a demo, but production should use Postgres or a Sheet, because static data is capped, is shared by all runs, and does not persist in manual test executions.
  - Text PDFs only. Scanned images need OCR first.
  - Invoices only for now. The schema and validation file are the only parts that change for other document types.
  - The confidence scores are the model's own estimates, so they are a weak signal. The math checks and the human review queue are what make this safe.

## Setup

1. In n8n, import `workflows/document-intake-agent.json`.
2. Create a **Header Auth** credential named `Anthropic API Key`: header name `x-api-key`, value is your Anthropic API key. Attach it to the **Claude Extract** node.
3. Optional audit log: create a Google Sheet with a tab named `Invoices` and the headers in `docs/invoice-log-columns.md`, add a **Google Sheets OAuth2** credential in n8n, then set the sheet ID in the **Append to Invoice Log** node (or rebuild with `node scripts/build-workflow.js --sheet-id <ID>`). To run without it, delete the **Build Sheet Row** and **Append to Invoice Log** nodes.
4. Check the model name at the top of the **Build Claude Request** node (`claude-sonnet-5-5`) and change it if you want a different one.
5. Activate the workflow, then:

```bash
curl -X POST http://localhost:5678/webhook/intake -F "file=@samples/invoice-clean.pdf"
curl http://localhost:5678/webhook/queue
```

## Sample documents (all fictional)

| File | What it tests | Expected result |
|---|---|---|
| `invoice-clean.pdf` | Everything adds up | `auto_approved` |
| `invoice-bad-totals.pdf` | Total is 725.00 but items sum to 575.00 | `needs_review` |
| `invoice-injection.pdf` | Contains "ignore all previous instructions" text | `needs_review` |
| `not-an-invoice.pdf` | Meeting notes | `needs_review` |

## Tests

```bash
npm test                      # 13 unit tests for the validation rules
node tests/mock-claude-server.js &   # stand-in for the Claude API
# import the test variant, activate it, then:
node scripts/build-workflow.js --mock-url http://localhost:9999/v1/messages --out /tmp/test-workflow.json
node tests/e2e.js             # end-to-end: routing, dedupe, retries, dead letter, corrupt PDF
```

The end-to-end suite ran against n8n 2.35.7 with a mock Claude endpoint. The mock returns canned answers, so it tests the workflow logic (routing, retries, duplicates, queues), **not Claude's extraction accuracy**. Run the sample PDFs against the real API before relying on it.

## Documentation

- [`docs/OPERATING_GUIDE.md`](docs/OPERATING_GUIDE.md): how to run, call, and monitor the workflow
- [`docs/SOP.md`](docs/SOP.md): step-by-step procedure for the person reviewing flagged invoices
- [`docs/invoice-log-columns.md`](docs/invoice-log-columns.md): the audit-log schema

## Repo layout

```
src/validate.js          validation rules (also inlined into the n8n Code node)
src/claude-request.js    prompt, JSON schema, request builder
scripts/build-workflow.js  assembles the workflow JSON from src/
scripts/make_samples.py    generates the sample PDFs
tests/                   unit tests, mock Claude server, end-to-end test
workflows/               the importable n8n workflow
docs/                    operating guide, review SOP, audit-log schema
```

Edit the files in `src/`, then run `npm run build` to regenerate the workflow JSON.

## Ideas for next steps

- Swap static-data queues for Postgres or Google Sheets, and post new review items to Slack.
- Add an approve/reject webhook so the reviewer's decision completes the record.
- Add OCR for scanned documents and support more document types.
- Log token cost per document and alert above a threshold.
