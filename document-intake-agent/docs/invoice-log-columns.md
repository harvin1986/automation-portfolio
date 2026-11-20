# Invoice audit log: Google Sheet schema

Create a tab named `Invoices` with these headers in row 1, in this order. The workflow maps its output to the headers by name.

| Column | Filled by | Meaning |
|---|---|---|
| Received At | workflow | ISO timestamp the row was written |
| File Name | workflow | Name of the uploaded PDF |
| Status | workflow | `auto_approved` or `needs_review` |
| Review Reasons | workflow | Plain-English reasons, separated by `;` |
| Vendor | workflow | Extracted vendor name |
| Invoice Number | workflow | Extracted invoice number |
| Invoice Date | workflow | `YYYY-MM-DD` |
| Due Date | workflow | `YYYY-MM-DD` |
| Currency | workflow | ISO 4217 code |
| Subtotal | workflow | Number |
| Tax | workflow | Number |
| Total | workflow | Number |
| Line Items | workflow | Count of line items |
| Lowest Confidence | workflow | Lowest per-field model confidence (0 to 1) |
| Suspicious Content | workflow | `TRUE` if the document looked like it was trying to instruct the model |
| Document ID | workflow | SHA-256 of the document text (the idempotency key) |
| Reviewed By | reviewer | Filled in by hand during review |
| Review Notes | reviewer | Filled in by hand during review |

Suggested Summary tab formulas: `=COUNTIF(Invoices!C:C,"needs_review")`, `=SUMIFS(Invoices!L:L,Invoices!C:C,"auto_approved")`.
