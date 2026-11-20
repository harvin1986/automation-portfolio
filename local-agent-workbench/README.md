# Local Agent Workbench

A self-hosted AI task runner for your own machine, backed by your PostgreSQL database. Define tasks in Markdown, give each one a small set of tools, and let Claude do the work on a schedule. Anything that changes state waits for your approval.

Node.js 20+, one dependency (`pg`), no framework. Runs on Windows, macOS and Linux.

## What it does
- **Tasks as files** (`tasks/*.md`): goal, allowed tools, folders, domains, cron schedule.
- **Tools**: `fs.list`, `fs.read_text`, `fs.move`, `fs.write_text`, `web.fetch`, `db.query` (read-only), `note.save`.
- **Approval queue**: writes pause the run until you approve in the local web console or CLI. Pending runs survive restarts.
- **Scheduler**: cron, exactly-once per slot, one catch-up run after downtime.
- **Audit log**: append-only, hash-chained, verifiable.
- **Guardrails**: sandboxed paths, SSRF-safe fetch, taint tracking for untrusted content, step/token limits. See [docs/SECURITY.md](docs/SECURITY.md).

## Setup
```
git clone https://github.com/harvin1986/automation-portfolio
cd automation-portfolio/local-agent-workbench
npm install
cp .env.example .env     # set DATABASE_URL, ANTHROPIC_API_KEY, WORKBENCH_ROOTS
npm run migrate          # creates a separate "workbench" schema; touches nothing else
node bin/workbench.js sync    # load tasks/*.md
node bin/workbench.js start   # scheduler + console on http://127.0.0.1:<port> (token printed)
```
Other commands: `run <task>`, `approvals`, `verify`. Set `DATA_DATABASE_URL` to a read-only role if you want `db.query` to read a different database.

## Tests
```
TEST_ADMIN_URL=postgres://user:pass@localhost:5432/postgres npm test
```
37 tests create a throwaway database per file and cover the agent loop, approvals, restarts, sandboxing, audit chain, scheduler concurrency and the web console. The model is scripted, so these test the machinery, not Claude's judgment. The console has not been tried in a real browser.
