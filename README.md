# Automation Portfolio

Production-minded automation and AI-integration projects by Ryan, a senior automation engineer. Each project is self-contained: source, tests, sample data, and operating documentation.

## Projects

| Project | Stack | What it shows |
|---|---|---|
| [**Document Intake Agent**](document-intake-agent/) | n8n, Claude API, Node.js, Google Sheets | An invoice-processing pipeline that uses an LLM without trusting it: schema-forced extraction, deterministic validation, idempotency, human review queue, dead-letter handling, prompt-injection defenses, audit log |

## How I build automations

- **Treat model output as untrusted.** Independent code checks (math, dates, required fields, injection patterns) decide what is auto-approved; everything else goes to a person with the reasons attached.
- **Design for failure.** Retries with timeouts, dead-letter queues, idempotency keys, and non-blocking logging so nothing disappears silently.
- **Keep sensitive data out of logs.** Failure records hold metadata only, and secrets live in credentials, never in workflow files.
- **Test the logic.** Unit tests for the rules, a mock API server and end-to-end tests for routing, retries and duplicates.
- **Document for operators.** Every project ships a run guide and an SOP for the people who will use it.

## Contact

GitHub: [@harvin1986](https://github.com/harvin1986)
