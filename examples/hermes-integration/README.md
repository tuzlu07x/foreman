# Wiring Hermes through Foreman

Hermes (Nous Research's personal AI assistant for Telegram and Discord) sits in the same stack as Foreman's target user. Hermes ≥ 2.0 speaks MCP, so we hand its tool calls to `foreman mcp-stdio` and watch them flow through the gateway. For pre-2.0 Hermes, see the note about `foreman wrap` at the bottom.

This recipe is intentionally short — when Hermes changes its config format, follow the [upstream config docs](https://github.com/NousResearch/hermes-agent#configuration) and only the `foreman:` MCP server entry is ours to maintain.

## 1. Install Foreman + Hermes

```bash
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
foreman init                       # ~/.foreman/ (identity, policy, db)
foreman secrets add anthropic-key  # stored once, every agent reads it back
```

The fast path uses Foreman's agent wizard (from [#60](https://github.com/tuzlu07x/foreman/issues/60)) and the curated registry (from [#73](https://github.com/tuzlu07x/foreman/issues/73)):

```bash
foreman agent add hermes --type hermes --auto-install
```

That command looks up Hermes in `registry/agents.json`, runs `npm install -g hermes-agent` when missing, injects the MCP snippet into `~/.hermes/config.yaml`, and registers Hermes with Foreman. Skip the rest of step 2 if this worked.

## 2. (Manual) point Hermes at Foreman

If you'd rather wire things by hand, install Hermes yourself and append the foreman block:

```bash
npm install -g hermes-agent
```

```yaml
# ~/.hermes/config.yaml — append this block, leave the rest of the file alone
mcp:
  enabled: true
  servers:
    foreman:
      command: foreman
      args: ["mcp-stdio", "--source", "hermes"]
secrets:
  source: foreman
  required:
    - anthropic-key
```

Hermes' real config keys evolve faster than this doc — pull the current skeleton from upstream and just merge in the `foreman:` server entry.

## 3. Apply the phishing-safe policy

```bash
cp examples/hermes-integration/example-policy.yaml ~/.foreman/policy.yaml
foreman policy show
```

[`example-policy.yaml`](./example-policy.yaml) restricts the request shapes that phishing prompts pivot on:

- `read_file` / `write_file` on `.env`, `*.key`, `id_rsa`, `id_ed25519`, anything under `~/.ssh/`, `~/.aws/credentials` → **ask**
- `shell_exec` containing `rm -rf`, `chmod 777`, `| sh`, `| bash`, `curl`, `wget` → **ask**
- `list_files`, `stat`, generic `read_file` → **allow** (Hermes' normal idle traffic)
- 60 msg/min, 200K tokens/hour rate limit on Hermes

## 4. Run them together

In one terminal:

```bash
foreman start            # boots the TUI
```

In another:

```bash
hermes serve             # whatever your Hermes process is
```

Now message Hermes through Telegram or Discord. Foreman's Activity panel scrolls every MCP tool call live.

- A normal `read_file("README.md")` → `✓ allow · policy:N · Xms`
- A phishing prompt's `read_file(".env")` → ⚠ approval modal with the path, risk score, and reasons. Press `[d]` to deny, `[a]` to allow, `[r]` to remember.

## 5. Audit afterwards

```bash
foreman log search "secret"          # everything that touched a secret-shaped path
foreman log search ".env"            # specifically .env reads
foreman log show <request-id>        # full payload of a single call
```

## Troubleshooting

| Symptom                                              | Fix                                                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes logs `MCP server foreman: connection refused` | `which foreman` — update the `command` in the Hermes config to the absolute path. Try `foreman mcp-stdio --source hermes` manually to confirm it stays alive.          |
| Activity panel stays empty                           | Hermes only fires tool calls when the conversation needs one. Ask it to read a file or run a command.                                                                  |
| `foreman` not on PATH after the curl installer       | `export PATH="$(npm prefix -g)/bin:$PATH"` or source nvm first if the installer bootstrapped it.                                                                       |
| Hermes < 2.0 (no MCP support)                        | Wait for [`foreman wrap`](https://github.com/tuzlu07x/foreman/issues/67) — it launches Hermes as a child and intercepts the tool calls without Hermes needing to know. |
