# Operating Guide

## What it does
Accepts a PDF invoice over HTTP, extracts structured data with Claude, validates it with deterministic code, and routes it to auto-approval, a human review queue, or a dead-letter list. Every result is also appended to a Google Sheet.

## Input
`POST /webhook/intake`, multipart form, field name `file`, a text-based PDF (scans need OCR first).

```bash
curl -X POST https://<your-n8n-host>/webhook/intake -F "file=@samples/invoice-clean.pdf"
```

## Responses
| HTTP | `status` | Meaning |
|---|---|---|
| 200 | `auto_approved` | Passed every check |
| 202 | `needs_review` | Failed a check; `reasons` explains why |
| 200 | `duplicate` | Same document text was already processed; earlier result returned |
| 502 | `error` | PDF unreadable or Claude call failed after 3 tries; item is in the dead letter |

## Monitoring
`GET /webhook/queue` returns counts, the review queue, the dead letter, and the 20 most recent approvals. Lists hold the 200 most recent entries each. The Google Sheet is the permanent record.

## Test vs production URLs
n8n shows a **test URL** (`/webhook-test/...`) that listens once per **Execute workflow** click, and a **production URL** (`/webhook/...`) that works while the workflow is active. Duplicate detection and the status queues use workflow static data, which is only saved in production runs.

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| Empty 200 on first test | Listening from the webhook node panel only runs that node | Click **Execute workflow** on the canvas, then send again |
| 502 with a 400 from Anthropic | Request rejected (for example an unsupported `tool_choice` for the model) | Check the **Claude Extract** node output; keep `tool_choice` as `auto` |
| 401 from Anthropic | Missing or wrong API key credential | Re-check the Header Auth credential (`x-api-key`) |
| No sheet rows | Sheets credential or sheet ID missing | Reconnect the Google credential and set the sheet ID |
| Everything goes to review | Confidence threshold (0.85) or math check failing | Read `reasons` in the response or the sheet |
