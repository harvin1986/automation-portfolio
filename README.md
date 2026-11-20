# Automation Portfolio

Production-minded automation and AI-integration projects by Ryan, a senior automation engineer. Each project is self-contained: source, tests, sample data, and operating documentation.

## Projects

| Project | Stack | What it shows |
|---|---|---|
| [**Customer Reconciliation Engine**](customer-reconciliation-engine/) | n8n, Claude API, Node.js | Reconciles customer records across a CRM and billing system: deterministic + fuzzy matching, AI used only to advise on ambiguous pairs behind rule gates, per-field ownership, idempotent writes, dry-run default, blast-radius guard, self-healing retries, human review loop, stateful-fake simulation tests |
| [**Local Agent Workbench**](local-agent-workbench/) | Node.js, PostgreSQL, Claude API | Self-hosted task runner: Markdown-defined tasks, sandboxed tools, human approval queue bound to input hashes, exactly-once scheduler, hash-chained audit log, resumable runs, localhost console; 37 tests against real Postgres (scripted model) |
| [**Support Triage Agent**](support-triage-agent/) | n8n, Claude API, Node.js | Signed-webhook ticket triage: HMAC auth with replay protection, PII redaction before the LLM, a policy engine that limits what the AI may do alone, signed single-use approval links, LLM circuit breaker, SLA tracking, daily digest, workflow simulator tests |
| [**Document Intake Agent**](document-intake-agent/) | n8n, Claude API, Node.js, Google Sheets | An invoice-processing pipeline that uses an LLM without trusting it: schema-forced extraction, deterministic validation, idempotency, human review queue, dead-letter handling, prompt-injection defenses, audit log |

## How I build automations

- **Treat model output as untrusted.** Independent code checks (math, dates, required fields, injection patterns) decide what is auto-approved; everything else goes to a person with the reasons attached.
- **Design for failure.** Retries with timeouts, dead-letter queues, idempotency keys, and non-blocking logging so nothing disappears silently.
- **Keep sensitive data out of logs.** Failure records hold metadata only, and secrets live in credentials, never in workflow files.
- **Test the logic.** Unit tests for the rules, a mock API server and end-to-end tests for routing, retries and duplicates.
- **Document for operators.** Every project ships a run guide and an SOP for the people who will use it.

## Contact

GitHub: [@harvin1986](https://github.com/harvin1986)
