# Wiring Claude Code through Foreman

Foreman ships a `mcp-stdio` subcommand that acts as an MCP server over a child process's stdio. Point Claude Code at it and every tool call from Claude flows through Foreman's mediator pipeline — auth, policy, risk, approval, audit.

## 1. Initialise Foreman (once)

```bash
npm install -g foreman-agent     # or `npm link` from a local clone
foreman init                     # creates Foreman's home (identity, policy.yaml, foreman.db)
```

## 2. Start the Foreman TUI

```bash
foreman start
```

You should see the boot banner, then the empty dashboard. Leave this running in one terminal: it is what shows you approvals (see [how approvals work](../../docs/tui.md#how-approvals-work)). If it's closed, a call that needs your approval is denied when it times out.

## 3. Point Claude Code at Foreman

<!-- pending: #656/#657 -->
The easy way: `foreman agent add claude-code` registers Claude Code and writes the `foreman` entry, with its identity token, into `~/.claude.json`, where Claude Code reads user-scope MCP servers (`mcpServers`). `~/.claude/settings.json` is not an MCP config: it only gets the env projection and, with `foreman agent hook install`, the PreToolUse hook.

To wire it by hand, register it and write its identity token to a file first:

<!-- pending: #656/#657 -->
```bash
foreman agent add claude-code --skip-config --token-out ~/.claude-code-foreman.token
```

Then register Foreman as a user-scope MCP server so it loads in every project (the token briefly shows up in this one command's argument list):

```bash
claude mcp add --scope user foreman -e FOREMAN_AGENT_TOKEN="$(cat ~/.claude-code-foreman.token)" -- foreman mcp-stdio --source claude-code
```

That writes this entry under `mcpServers` in `~/.claude.json` (you can also add it there by hand; keep it out of a project's `.mcp.json`, which is usually committed to git):

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman",
      "args": ["mcp-stdio", "--source", "claude-code"],
      "env": { "FOREMAN_AGENT_TOKEN": "<contents of ~/.claude-code-foreman.token>" }
    }
  }
}
```

- `--source` is the agent id Foreman records on every request. `claude-code` is the convention; pick whatever matches your other policy rules.
- `FOREMAN_AGENT_TOKEN` proves the id. Without it (or with a wrong one) the connection runs as `untrusted:claude-code`: none of `claude-code`'s allow rules, org role or MCP hub servers (its deny rules still apply). Delete the token file once it's wired, and never pass the token to `foreman` as an argument. See [agent identity tokens](../../docs/agent-lifecycle.md#agent-identity-tokens).
- Everything after `--` is passed to the server untouched. If you installed without `-g`, replace `foreman` after the `--` with `node /absolute/path/to/dist/cli/index.js`.

## 4. Check the connection

```bash
claude mcp get foreman
```

Start a new Claude Code session so it picks up the server.

Now every `tools/call` Claude makes through this MCP server flows through Foreman. You'll see them live in the TUI's Activity panel.

## 5. Tighten the policy

Claude Code's built-in tools reach Foreman through the PreToolUse hook (`foreman agent hook install claude-code`), under Foreman's tool names: `Bash` is `shell_exec`, `Read` is `read_file`, and `Write` / `Edit` are `file_write` (see [tool names](../../docs/policy.md#tool-names)). Rules for them go under `rules:` in `policy.yaml`, for example:

```yaml
rules:
  # Claude Code may never touch private keys.
  - source: claude-code
    target: "tool:read_file"
    effect: deny
    conditions:
      pathMatch: ["\\.pem$", "/\\.ssh/"]
  # Always ask before it runs a shell command.
  - source: claude-code
    target: "tool:shell_exec"
    effect: ask

agents:
  claude-code:
    rate_limits:
      messages_per_minute: 60
```

<!-- pending: #656/#657 -->
Edit it with `foreman policy edit` (or `e` on the TUI's Policy page); the change applies from the next call. [`docs/policy.md`](../../docs/policy.md) has every field.

## What you should see

- **Allow path**: Claude reads `README.md` → the default `read_file` allow rule matches → the TUI's Activity feed shows `✓ allowed · policy:N · Xms`.
- **Deny path**: Claude reads `~/.ssh/id_rsa` → the deny rule matches → Claude Code shows the call as blocked by Foreman (`policy:N`).
- **Ask path**: a rule says `ask`, or the risk engine scores the call 30 or more → the approval pops up in the TUI. Press `a` / `d` to allow once or deny, `A` / `D` to remember it, `i` to inspect.

## Troubleshooting

| Symptom                                        | Fix                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude shows `foreman: failed to connect`      | Confirm `which foreman` matches the path in `command`. Try `foreman mcp-stdio` manually to confirm it stays alive.                            |
| `Foreman is not initialised at …`              | Run `foreman init` once.                                                                                                                      |
| Activity panel stays empty                     | Claude only emits MCP calls when _it_ decides to use a tool. Ask it to read a file.                                                           |
