# Wiring Claude Code through Foreman

Foreman ships a `mcp-stdio` subcommand that acts as an MCP server over a child process's stdio. Point Claude Code at it and every tool call from Claude flows through Foreman's mediator pipeline — auth, policy, risk, approval, audit.

## 1. Initialise Foreman (once)

```bash
npm install -g foreman-agent     # or `npm link` from a local clone
foreman init                     # creates ~/.foreman/ (identity, policy.yaml, foreman.db)
```

## 2. Start the Foreman TUI

```bash
foreman start
```

You should see the boot banner, then the empty dashboard. Leave this running in one terminal.

## 3. Point Claude Code at Foreman

Register Foreman as a user-scope MCP server so it loads in every project:

```bash
claude mcp add --scope user foreman -- foreman mcp-stdio --source claude-code
```

Claude Code stores user-scope servers under `mcpServers` in `~/.claude.json` (not in `~/.claude/settings.json`). The command above writes this entry:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman",
      "args": ["mcp-stdio", "--source", "claude-code"]
    }
  }
}
```

- `--source` is the agent id Foreman records on every request. `claude-code` is the convention; pick whatever matches your other policy rules.
- Everything after `--` is passed to the server untouched. If you installed without `-g`, replace `foreman` after the `--` with `node /absolute/path/to/dist/cli/index.js`.

## 4. Check the connection

```bash
claude mcp get foreman
```

Start a new Claude Code session so it picks up the server.

Now every `tools/call` Claude makes through this MCP server flows through Foreman. You'll see them live in the TUI's Activity panel.

## 5. Tighten the policy

Drop something like this into `~/.foreman/policy.yaml`:

```yaml
agents:
  claude-code:
    can_call:
      foreman: [read_file, list_files, write_file]
    cannot_call:
      foreman: [run_shell, run_command]
    rate_limits:
      messages_per_minute: 60
```

Then either:

- Hit `e` in the policy page (`p`) inside the running TUI, or
- Run `foreman policy edit` in another terminal (the running TUI hot-reloads when you press `e` from its policy page after edits).

## What you should see

- **Allow path**: Claude calls `read_file("README.md")` → Foreman matches the `allow` rule → TUI Activity shows `✓ allow · policy:N · Xms`.
- **Deny path**: Claude calls `run_shell("rm -rf …")` → Foreman matches `deny` → Claude gets back an MCP error `Denied by policy:N`.
- **Ask path**: Claude calls something not in the policy, with risk ≥ 50 → the Approval modal pops up in the TUI. Press `a` / `d` / `r` / `i` to decide.

## Troubleshooting

| Symptom                                        | Fix                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude shows `foreman: failed to connect`      | Confirm `which foreman` matches the path in `command`. Try `foreman mcp-stdio` manually to confirm it stays alive.                            |
| `Foreman is not initialised at ~/.foreman/`    | Run `foreman init` once.                                                                                                                      |
| Activity panel stays empty                     | Claude only emits MCP calls when _it_ decides to use a tool. Ask it to read a file.                                                           |
| `Denied by route-error: no gateway configured` | Expected for v0.1 — there's no downstream agent to forward to yet. Foreman still records the call and returns success when the policy allows. |
