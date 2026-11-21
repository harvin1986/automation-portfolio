# Ticketing MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude (or any MCP client) a clean, safe interface into a ticketing system: search, read, create, comment and change status.

It is a small version of the problem enterprise AI platforms solve at scale: **let a language model use a business system without trusting the model, the data in the system, or the network.** The interesting part isn't the six tools. It's the engineering around them.

Node.js 20+, official MCP SDK, zod. Runs with zero setup against a built-in demo API.

## Try it in 60 seconds

```
npm install
claude mcp add ticketing -- node "$(pwd)/bin/mcp-ticket-server.js"
```
Then in Claude Code: *"Which urgent tickets are unassigned?"* or *"Triage T-1004."* See [docs/SETUP.md](docs/SETUP.md) for Claude Desktop, enabling writes, and pointing it at a real API.

## What it exposes

| Kind | Name | Notes |
|---|---|---|
| Tool | `tickets_search` | filters + free text, cursor pagination, summaries only to save context |
| Tool | `tickets_get` | full description and latest comments |
| Tool | `queue_stats` | counts by status / priority / assignee |
| Tool | `tickets_create`, `tickets_comment`, `tickets_update_status` | **only when `MCP_ALLOW_WRITES=1`**; two-step confirm |
| Resource | `tickets://stats`, `ticket://{id}` | for clients that attach context directly |
| Prompt | `triage_ticket`, `queue_report` | reusable workflows that are explicitly read-only |

All tools declare `readOnlyHint` / `destructiveHint` / `idempotentHint` annotations, typed input schemas, and structured output schemas.

## Design decisions

**The model is not trusted.**
- **Read-only by default.** Write tools aren't registered at all unless the operator turns them on, so a prompt can't talk the model into using something that isn't there.
- **Preview, then confirm.** A write tool first returns a preview and a `confirmation_token`. Executing requires the *same arguments* plus the token: an HMAC over tool + canonical arguments + nonce + expiry. It can't be forged, reused for different arguments, or used after 5 minutes. The assistant is expected to show the preview to the human first.
- **At-most-once.** The token's nonce doubles as the idempotency key, in-flight actions are locked, and a retry after success returns the original result instead of repeating the action. A failure releases the token so the same call can be retried safely.
- **Rate limiting** (token bucket) stops runaway loops before they reach the upstream API.

**The data is not trusted.**
- Ticket text is written by customers and outsiders. It is returned inside explicit `UNTRUSTED_TICKET_TEXT` fences with a reminder that it is data, not instructions. The fence delimiter is neutralized *inside* the text so a ticket can't close the block and smuggle instructions out. There's a seeded ticket that tries exactly this.
- Responses are sanitized (control characters, zero-width and bidi-override characters stripped) and truncated.
- **PII is redacted on the way out** (emails, phones, SSNs, Luhn-valid card numbers), on by default, so it never enters the model's context or the client's logs.

**The network is not trusted.**
- A dedicated HTTP backend owns auth, timeouts, and bounded retries with `Retry-After`. Reads and idempotent calls are retried; comments are **not**, because a retry would duplicate them. Errors are typed and mapped to messages that tell the model what to do next ("allowed next statuses: ...") without leaking URLs or tokens.
- Inputs are validated (ticket ids match a strict pattern before they can reach a URL path).

**It's operable.**
- Structured **audit log** (stderr or `MCP_AUDIT_FILE`, mode 0600): tool, outcome, latency, hash of the arguments, never ticket content.
- stdout is reserved for the protocol. Config errors fail fast with a clear message.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TICKETS_API_URL` | *(unset: demo mode)* | Base URL of the ticketing REST API |
| `TICKETS_API_TOKEN` | | Bearer token (required with a URL) |
| `MCP_ALLOW_WRITES` | `false` | Register the write tools |
| `MCP_REDACT_PII` | `true` | Redact PII in responses |
| `MCP_AUDIT_FILE` | stderr | Append audit lines to this file |
| `TICKETS_TIMEOUT_MS` | `8000` | Per-request timeout |

## Layout

```
src/server.js     tools, resources, prompts, error mapping
src/backend.js    HTTP client: auth, timeouts, retries, typed errors
src/safety.js     sanitizing, PII redaction, untrusted fencing, rate limit, confirmation tokens
src/audit.js      audit log
src/api/server.js reference ticketing REST API (the system being wrapped)
tests/            30 tests
```

## Tests

`npm test` runs 30 tests: a real MCP client talks to the server (in-process and over real stdio) which talks over real HTTP to the reference API. They cover pagination, validation, redaction, prompt-injection framing, the write flow (preview, wrong-arguments token, forged token, replay, failure and retry), rate limiting, retries, timeouts, auth failures, and the audit log.

Safety tests were checked by mutation: removing redaction, always registering write tools, making tokens ignore their arguments, un-neutralizing the delimiter, and disabling replay protection each make tests fail.

## Honest limits

- The "ticketing system" is a reference API I wrote for this repo. Pointing the server at Jira, Zendesk or ServiceNow means writing a backend adapter that maps their API to the same six operations (`src/backend.js` shows the shape). It isn't a drop-in for those products.
- Tests use a real MCP client but not a real model. How Claude behaves with the tools, and how well the injection fencing holds up against a determined attack, is not proven by these tests. Fencing and confirmation reduce the risk; they don't eliminate it.
- Per-user authorization isn't implemented: the server acts with one service token. A production deployment would pass the caller's identity through (OAuth) and enforce their permissions upstream.
- PII redaction is pattern-based; it will miss names and free-form addresses.
- Stdio transport only. A remote deployment would use the SDK's streamable HTTP transport behind authentication.
