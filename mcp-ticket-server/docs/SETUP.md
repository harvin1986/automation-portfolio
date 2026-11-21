# Setup

## Claude Code
```
npm install
claude mcp add ticketing -- node /absolute/path/to/mcp-ticket-server/bin/mcp-ticket-server.js
```
With writes enabled and an audit file:
```
claude mcp add ticketing -e MCP_ALLOW_WRITES=1 -e MCP_AUDIT_FILE=$HOME/ticketing-audit.jsonl -- node /absolute/path/to/mcp-ticket-server/bin/mcp-ticket-server.js
```
Check with `claude mcp list`, then ask: "What's in the ticket queue?"

## Claude Desktop
Add to `claude_desktop_config.json` and restart the app:
```json
{
  "mcpServers": {
    "ticketing": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-ticket-server/bin/mcp-ticket-server.js"],
      "env": { "MCP_ALLOW_WRITES": "0" }
    }
  }
}
```

## Pointing at a real API
Set `TICKETS_API_URL` and `TICKETS_API_TOKEN`. The API must provide the routes in `src/api/server.js`
(`GET /tickets`, `GET /tickets/:id`, `GET /stats`, `POST /tickets`, `PATCH /tickets/:id`, `POST /tickets/:id/comments`).
For a different vendor, change `src/backend.js` to map their API to the same methods; nothing else changes.

## Things to try
- "Which urgent or high tickets are unassigned?"
- "Triage T-1004." (contains PII; watch it come back redacted)
- "Summarize T-1007." (contains a prompt-injection attempt; the assistant should treat it as data)
- With writes on: "Move T-1002 to in progress." It should show a preview and wait for your approval.

## Running the demo API on its own
```
node -e "require('./src/api/server').createApi({token:'demo-token'}).listen(8080).then(s=>console.log(s.url))"
```
