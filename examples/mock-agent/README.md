# mock-agent

A 50-line MCP server that pretends to be a "personal assistant" agent — exposes two tools used by the Foreman phishing-scenario demo:

| Tool              | Behaviour                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| `read_email(id)`  | Returns one of three canned emails. ID `2` is a phishing message from `ahmet@kompany.co` (lookalike of `kompany.com`) asking for `.env`. |
| `forward_message(to, body)` | Pretends to forward, logs to **stderr only** — never sends anything. |

## Run it standalone

```bash
node examples/mock-agent/mock-agent.mjs
```

Then pipe MCP JSON-RPC to its stdin / read from stdout. Useful for poking at the protocol.

## Use from an MCP client

Add to your MCP client's `mcpServers` config (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "mock-agent": {
      "command": "node",
      "args": ["<absolute-path-to-foreman>/examples/mock-agent/mock-agent.mjs"]
    }
  }
}
```

## How it fits the demo

The phishing-scenario (asciinema in #26) uses this mock so the demo is **deterministic** — the same email content every run.

A real run would have:

1. Mock-agent (this script) — connected to your MCP client.
2. Foreman — connected to the same client at `foreman mcp-stdio`.
3. The client calls `read_email(2)` → mock returns the phishing email.
4. The client (or another agent) then calls `tools/call` against Foreman with `read_file(".env")` — Foreman intercepts, scores it ≥ 80, asks you in the TUI.

The mock is intentionally dumb. It doesn't talk to Foreman; it's a fixture for the bigger demo. The Foreman side does the actual mediation.
