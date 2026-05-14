# Wiring Hermes through Foreman

Hermes (Nous Research's personal AI assistant for Telegram and Discord) sits in the same stack as Foreman's target user. Hermes ≥ 2.0 speaks MCP, so we hand its tool calls to `foreman mcp-stdio` and watch them flow through the gateway. For pre-2.0 Hermes, see the note about `foreman wrap` at the bottom.

This recipe is intentionally short — when Hermes changes its config format, follow the [upstream config docs](https://github.com/NousResearch/hermes-agent#configuration) and only the `foreman:` MCP server entry is ours to maintain.

## 1. Install Foreman + Hermes

```bash
# Foreman
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
foreman init                       # ~/.foreman/ (identity, policy, db)
foreman secrets add anthropic-key  # stored once, every agent reads it back

# Hermes — official installer (curl on macOS / Linux / WSL2; PowerShell on Windows).
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup                       # one-time bootstrap
```

After Hermes is on PATH, Foreman's agent wizard (from [#60](https://github.com/tuzlu07x/foreman/issues/60)) registers it and wires its config:

```bash
foreman agent add hermes --type hermes
```

That command finds the installed `hermes` binary, injects the MCP snippet into `~/.hermes/config.yaml`, and registers Hermes with Foreman. Skip the rest of step 2 if this worked.

> **Why not `--auto-install`?** Hermes installs via `curl … | bash`, which Foreman refuses to auto-run unattended — the registry surfaces the command and the user pastes it.

## 2. (Manual) point Hermes at Foreman

If you'd rather wire things by hand, install Hermes from the official installer and merge the foreman block into its config:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup     # one-time bootstrap; writes ~/.hermes/config.yaml
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

Hermes' real config keys evolve faster than this doc — pull the current skeleton from upstream (`hermes setup` regenerates it) and just merge in the `foreman:` server entry.

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
hermes                   # whatever your Hermes process is (TUI or daemon)
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

| Symptom                                              | Fix                                                                                                                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes logs `MCP server foreman: connection refused` | `which foreman` — update the `command` in the Hermes config to the absolute path. Try `foreman mcp-stdio --source hermes` manually to confirm it stays alive.                                              |
| Activity panel stays empty                           | Hermes only fires tool calls when the conversation needs one. Ask it to read a file or run a command.                                                                                                      |
| `foreman` not on PATH after the curl installer       | `export PATH="$(npm prefix -g)/bin:$PATH"` or source nvm first if the installer bootstrapped it.                                                                                                           |
| Hermes < 2.0 (no MCP support)                        | Use `foreman wrap --name hermes -- hermes` — Foreman launches Hermes as a child and signs every MCP-framed response. See [`examples/wrap-example/README.md`](../wrap-example/README.md) for the mechanics. |
