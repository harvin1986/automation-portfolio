# Operating Guide

## Endpoints
| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /webhook/ticket` | HMAC signature + timestamp headers | Submit a ticket (`ticket_id`, `subject`, `body`) |
| `GET /webhook/approve?token=...` | Signed single-use token | Approve or reject a held reply |
| `GET /webhook/metrics` | Header Auth credential | Counts, pending approvals, SLA breaches, LLM usage |

## Signing a request
Send headers `X-Timestamp` (unix seconds) and `X-Signature: sha256=<hex>` where the hex is `HMAC-SHA256(secret, timestamp + "." + rawBody)`. `scripts/send-ticket.js` shows a working example.

## Responses to `POST /ticket`
| HTTP | `status` | Meaning |
|---|---|---|
| 200 | `auto_replied` | Low risk; reply sent |
| 202 | `pending_approval` | Held; approver notified with approve/reject links |
| 202 | `escalated` | Sent to on-call (p1, security, suspected injection, invalid AI output, or LLM unavailable) |
| 200 | `duplicate` | Ticket ID already processed |
| 401 | `rejected` | Bad signature, stale timestamp, missing headers |
| 400 | `rejected` | Invalid payload |
| 502 | `reply_failed` | The helpdesk reply API failed after retries |
| 500 | `rejected` | Server secret not configured |

## Monitoring
`/metrics` returns decisions by type, category and priority, pending approvals (with those past SLA), LLM calls, failures, token use and breaker state, and reply failures. The same numbers are posted by the weekday digest.

## Troubleshooting
| Symptom | Likely cause | Fix |
|---|---|---|
| Every request returns 401 `invalid_signature` | Secret mismatch, or the body was re-serialized before signing | Sign the exact raw bytes you send |
| 401 `stale_timestamp` | Sender clock is off by more than 5 minutes | Sync the sender's clock |
| 500 `server_not_configured` | `TRIAGE_WEBHOOK_SECRET` not set | Set the variable in n8n |
| Everything escalates with "circuit breaker is open" | 3 consecutive LLM failures | Check the Anthropic credential and API status; it retries after 5 minutes |
| Approve link says `invalid_link` | Expired (24 h) or altered link | Re-submit or decide manually in the helpdesk |
| Duplicate detection resets | Static data is not saved in test executions | Use the production URL with the workflow active |
