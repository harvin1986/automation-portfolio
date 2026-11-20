# Operating Guide

## What runs and when
- **Hourly schedule** and **`POST /webhook/run`** both start a run.
- A run fetches all CRM contacts and billing accounts, matches them, plans changes, and (unless it is a dry run) applies them.

## Endpoints (all require the Reconciliation Admin Key header)
| Endpoint | Purpose |
|---|---|
| `POST /webhook/run` | Start a run. Body: `{ "dryRun": true\|false, "force": true\|false }` |
| `GET /webhook/review` | Last run summary, review queue, conflicts, dead letter, cached link count |
| `POST /webhook/decide` | Resolve a review pair: `{ "crm_id": "...", "billing_id": "...", "decision": "link"\|"reject" }` |

## Run modes
| Mode | How | Effect |
|---|---|---|
| Dry run (default) | no body, or `dryRun: true` | Plans and reports; writes nothing; does not save link decisions |
| Live | `dryRun: false` | Applies planned changes |
| Forced live | `dryRun: false, force: true` | Applies even when the safety guard would halt |

## Reading the report
`status` is one of `success`, `partial` (some updates failed and will retry), `dry_run`, `halted_guard`, or `failed` (data fetch failed, nothing written). Key numbers: **drift %** (matched records needing a change), **review** (pairs waiting for a human), **conflicts** (one record claimed by two), **unmatched CRM** and **orphan billing** (no counterpart found).

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| `halted_guard` | More than 20% of records would change (min 10) | Inspect the data and upstream exports; if the change is genuine, re-run with `force: true` |
| `failed` | CRM or billing fetch failed | Check credentials and API status; nothing was written; the lock is already released |
| `partial` | Some PATCH calls failed | See `deadLetter` in `/review`; the next run retries them automatically |
| Run skipped | Another run holds the lock | Wait; a stale lock expires after 30 minutes |
| Same pair keeps appearing in review | Not yet decided | `POST /decide` with link or reject |
| Review queue and links reset | Static data not saved in test executions | Use the production webhook with the workflow active |
