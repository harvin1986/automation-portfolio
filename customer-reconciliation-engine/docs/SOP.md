# SOP: Data steward, working the review queue

**Purpose:** make sure no two records are merged, and no data is overwritten, on a guess.
**When:** after each business day's runs, and whenever the report says `review > 0`, `conflicts > 0`, or `halted_guard`.

## Review queue (pairs the system could not settle)
1. Call `GET /review` and take each `{crm_id, billing_id, score}`.
2. Open both records in their systems. Decide whether they are the same real person or company (look at name, address, phone, email, account history).
3. Same entity: `POST /decide` with `"decision": "link"`. Different: `"decision": "reject"`.
4. If unsure, leave it. Unresolved pairs never trigger writes.

## Conflicts
- **duplicate_claim** (two CRM records match one billing account): usually a duplicate in the CRM. Merge or fix the duplicate in the CRM; the next run clears the conflict.
- **multiple_billing_candidates**: usually a duplicate billing account. Fix in billing.

## Dead letter (failed updates)
Failures retry automatically each run. If the same record fails repeatedly, check the record in the target system (locked, deleted, or invalid value) and fix it there.

## Halted by the safety guard
1. Do not force the run until you know why so many records changed.
2. Compare a sample of changes against the source systems. Typical causes: a broken export, a field that changed format, or a bulk edit upstream.
3. If the changes are legitimate, re-run with `force: true`. Otherwise fix the source and run again.

## Weekly
- Review drift %, unmatched CRM and orphan billing trends; investigate sudden jumps.
- Rotate the three API credentials and the admin key on your normal schedule.
