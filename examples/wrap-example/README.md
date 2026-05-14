# `foreman wrap` example — Python agent under Foreman

This is the smallest possible smoke test for `foreman wrap`. The Python script in this directory emits three MCP `tools/call` messages on stdout — one safe (`list_files`), one secret-shaped (`read_file .env`), one dangerous shell (`rm -rf /tmp/foreman-demo`) — and prints whatever Foreman sends back on its stderr.

## Run

```bash
foreman init                         # one-time
foreman wrap --name py-agent -- python3 examples/wrap-example/agent.py
```

Expected output (with the smart-default policy):

```
(wrap) registered new agent "py-agent" — store the private key now (printed once):
<hex...>
(py-agent) #1 list_files: (foreman) tools/call allowed by policy:N
(py-agent) #2 read_file: (foreman) tools/call allowed by user        # ⚠ approval modal popped, you pressed `a`
(py-agent) #3 shell_exec: (foreman) tools/call allowed by user        # ⚠ another modal
```

If you press `[d]` instead of `[a]` on either modal, the agent gets a JSON-RPC error response (`Denied by user`).

## What this proves

- Stdout of an arbitrary process is parsed as MCP frames (`createDecoder` handles partial chunks).
- Each call hits `MediatorService.handleRequest` with `sourceAgent: "py-agent"` and the appropriate `targetTool`.
- The policy-default `ask` rules for `read_file .env` and `shell_exec rm -rf` trigger the approval modal in the Foreman TUI (run `foreman start` in another terminal to see the activity feed live).
- The wrapped agent's stderr passes through to your terminal so you can debug normally.

## When to use `foreman wrap` vs `foreman mcp-stdio`

- The **agent speaks MCP** but doesn't know about Foreman: use `foreman mcp-stdio` and point the agent's MCP server config at Foreman. The agent stays in charge of its own lifecycle.
- The **agent doesn't speak MCP**, or you want Foreman to own the process lifecycle (`Ctrl-C` here stops the child cleanly, `--restart on-failure` brings it back up): use `foreman wrap`.

## Restart on failure

```bash
foreman wrap --name py-agent --restart on-failure -- python3 examples/wrap-example/agent.py
```

Foreman restarts the child up to five times with a 1 s backoff if it exits non-zero. Clean exits (code 0) are never restarted. `Ctrl-C` always wins.
