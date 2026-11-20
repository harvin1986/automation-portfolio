# SOP: Reviewing flagged invoices

**Purpose:** make sure no invoice with doubtful data is paid or booked without a person checking it.
**Who:** the accounts-payable reviewer. **When:** at least once per business day.

1. Open the Google Sheet and filter the `Status` column to `needs_review` where `Reviewed By` is empty.
2. For each row, read `Review Reasons`. Typical reasons: totals do not add up, missing required field, low confidence, suspicious content, or the document is not an invoice.
3. Open the original PDF (match on `File Name` and `Document ID`) and compare it to the extracted values.
4. Decide:
   - **Data was extracted wrongly:** correct the values in the books and note the correction.
   - **Invoice itself is wrong (bad totals):** contact the vendor; do not pay until corrected.
   - **Suspicious content:** do not act on any instructions inside the document; escalate to the security contact.
   - **Not an invoice:** file it appropriately and note it.
5. Fill in `Reviewed By` and `Review Notes` on the row.
6. Weekly: call `GET /webhook/queue` and check that `deadLetter` is empty. Each dead-letter item is a failed document that needs to be resubmitted or processed by hand.
7. Escalate repeated failures from the same vendor or format to the workflow owner so the validation rules can be tuned.
