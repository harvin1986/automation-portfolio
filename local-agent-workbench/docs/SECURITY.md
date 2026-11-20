# Security model

The agent is a language model that reads untrusted text and can call tools. The design assumes it can be manipulated and limits the damage.

| Threat | Control |
|---|---|
| Prompt injection in a file, web page or DB row makes the agent do something harmful | Each task lists its tools; anything that changes state (`fs.move`, `fs.write_text`) needs human approval of the exact input. Runs that read untrusted content are flagged on the approval, or blocked with `on_untrusted_write: block`. |
| Approval swapped after the fact | Approvals store an input hash; it is re-checked immediately before execution. |
| Double execution after a crash | Approval is claimed (`executed`) before the action runs: at-most-once for writes. |
| Path traversal / symlink escape | Paths are resolved with `realpath` and must be inside the task's folders, which are clipped to `WORKBENCH_ROOTS`. |
| SSRF via `web.fetch` | https only, domain allowlist, no IP literals, redirects re-checked, private addresses refused after DNS resolution. |
| Destructive SQL | `db.query` allows a single SELECT, runs in a READ ONLY transaction with a 5 s timeout and a 200-row cap. Use a read-only database role for `DATA_DATABASE_URL` as the real boundary. |
| Log tampering | `audit_log` is append-only (triggers) and hash-chained; `workbench verify` and the Audit page detect edits. Someone with superuser access can disable triggers, but the chain shows where it was altered. |
| Local web console attacks | Bound to localhost, Host allowlist (DNS rebinding), session cookie (HttpOnly, SameSite=Strict), CSRF token, Origin check, strict CSP, escaped output. |
| Secret leakage | API keys and DB passwords are redacted before anything is stored or logged. |
| Runaway cost | Step limit, token budget and run timeout per run. |

## Not covered
- The model can still be wrong or persuasive inside what you approve. Read approvals.
- Tests use a scripted model; behavior with the real model is untested.
- `db.query` keyword filtering is defense in depth, not a substitute for a read-only role.
