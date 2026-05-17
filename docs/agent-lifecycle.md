# Agent lifecycle

Foreman manages each agent from install through removal. The same operations are available via the CLI (`foreman agent ...`) and the TUI Agents page (`[a]` hotkey).

## Lifecycle states

```
   ┌────────────┐    install     ┌────────────┐
   │ uninstalled│───────────────▶│  enabled   │◀──── enable
   └────────────┘                └─────┬──────┘
                                       │  disable
                                       ▼
   ┌────────────┐    block      ┌────────────┐
   │  blocked   │◀──────────────│  disabled  │
   └─────┬──────┘               └────────────┘
         │  unblock
         ▼
     enabled

   any state ──────remove──────▶ uninstalled
```

- **enabled** — default after install. Agent can make MCP calls; Foreman mediates per policy.
- **disabled** — registered but inactive. MCP calls return a "disabled" error without going through the policy engine. Use this to pause an agent without losing its config or its slot in the wizard.
- **blocked** — Foreman refuses every call from the agent and writes an audit row for each attempt. Use this when an agent's behavior has gone off the rails and you want a paper trail.
- **uninstalled** — not registered. The agent binary may still be on disk (Foreman's `remove` defaults to keeping it; `--keep-binary` is the default for script-installed agents like Hermes).

## CLI surface

| Command | Purpose |
|---|---|
| `foreman agent list` | tabular list of registered agents + state |
| `foreman agent add [name]` | register an agent (looks up `registry/agents.json` if `name` is provided) |
| `foreman agent show <name>` | full record — id, public key, state, config path, registered secrets |
| `foreman agent update [name]` | re-fetch registry entry + re-inject MCP block |
| `foreman agent remove <name> [--keep-binary]` | unregister + strip MCP block from config + (optionally) uninstall binary |
| `foreman agent regenerate-key <name>` | issue a new Ed25519 keypair (revokes the old one) |
| `foreman agent block <agentId>` | force every call to deny + audit |
| `foreman agent unblock <agentId>` | return to whatever state the agent was in before block |
| `foreman agent disable <agentId>` | pause without auditing every attempt |
| `foreman agent enable <agentId>` | resume from disabled |

`foreman agents` is an alias for `foreman agent`.

## TUI flow

Open the Agents page with `[a]` from the dashboard:

```
 Agents (4)
 ─────────────
 ▸ claude-code     enabled   anthropic   "code review"
   hermes          enabled   anthropic   "telegram chat"
   codex           disabled  openai      —
   openclaw        blocked   anthropic   "spam-filter test"
```

Per-row hotkeys:

- `[e]` edit — change LLM provider (for multi-provider agents) + responsibility note
- `[d]` disable / enable
- `[b]` block / unblock
- `[r]` regenerate key
- `[x]` remove

The responsibility note is a free-text answer to "why did I install this agent again, 3 months later?" — it surfaces in audit logs, approval prompts, and the dashboard.

## What gets cleaned up on `remove`

When you remove an agent, Foreman:

1. Strips the `mcpServers.foreman` (or `mcp_servers.foreman` for Codex's TOML, or `mcp.servers.foreman` for niche configs) entry from every `config_paths` entry. No orphaned MCP blocks.
2. Deletes the agent's row from the DB (and any per-agent config like `llmProvider` / `responsibilityNote`).
3. Revokes the Ed25519 keypair — even if the binary is left on disk, a new install can't impersonate the removed agent.
4. **Does not** delete the agent's own config files outside the MCP block, the agent's binary (unless install was via `npm`/`brew` and you didn't pass `--keep-binary`), or anything in the agent's own state dir (`~/.hermes/`, `~/.openclaw/`, etc.).

For script-installed agents like Hermes, removal prints the manual uninstall hint:

```
Remove the hermes binary manually (try the installer's --uninstall flag).
```

## Identity push

If the agent's registry entry declares an `identity_path` (e.g. `~/.hermes/SOUL.md` for Hermes), `foreman agent add` writes Foreman's canonical `<foreman_home>/SOUL.md` into that location so the partner runtime greets the user as Foreman rather than its own brand. To re-push after editing Foreman's identity:

```bash
foreman identity push
```

The push is best-effort — some runtimes (notably Hermes' core LLM prompt) weight their built-in system prompt above any user-supplied SOUL.md. The push still gets you the strongest available identity hook for that runtime; whether the upstream LLM respects it is upstream's call. See [`docs/qa-report-v0.1.0.md`](qa-report-v0.1.0.md) for the original Hermes identity finding.

## Secret projection (#222 / #223)

After MCP injection finishes, `foreman setup` and `foreman agent add` **also** write the agent's required API keys / channel tokens into the agent's own env/config files. The promise: a fresh user finishes the wizard and can launch the agent without any `hermes model` / `codex login` / manual `.env` editing.

### Why we write to disk

Foreman's MCP transport handles policy + audit at runtime, but every tier-1 agent reads its inference key at *startup* — before MCP is reachable. Without projection, the wizard's "set it up once" promise breaks. We accept the tradeoff: the secret lives in **two** places now (Foreman's encrypted store + the agent's own config), but with a single rotation point.

### Where each agent's secrets land

| Agent | File | Writer strategy |
| --- | --- | --- |
| Hermes | `~/.hermes/.env` | dotenv (mode 0600, merges with user's own keys) |
| Claude Code | `~/.claude/settings.json` → `env` block | deep-merged JSON |
| OpenClaw | `~/.openclaw/openclaw.json` → `env` + `channels.*` | deep-merged JSON |
| Codex | `~/.codex/config.toml` (`preferred_auth_method`) + `~/.codex/auth.json` (`OPENAI_API_KEY`) | line-level TOML + flat JSON |
| ZeroClaw | `~/.zeroclaw/config.toml` (`default_provider` + `api_key`) | line-level TOML |
| generic-mcp | (no auto-write) | — |

All writers are **atomic** (tmpfile + rename), **chmod 0600**, and **preserve sibling keys** the user added by hand.

### Filtering — `if_provider` and `if_service`

Each projection mapping in the registry can be gated:

```json
{
  "ANTHROPIC_API_KEY": { "from_secret": "anthropic-key", "if_provider": "anthropic" },
  "TELEGRAM_BOT_TOKEN": { "from_secret": "telegram-bot-token", "if_service": "telegram" }
}
```

A user who picked OpenAI (not Anthropic) won't get an `ANTHROPIC_API_KEY` written, and a user who didn't pick Telegram won't get the bot token.

### Rotation fanout

`foreman secrets rotate <name>` re-projects the new value into every agent whose registry block references it:

```
$ foreman secrets rotate anthropic-key
✓ rotated secret "anthropic-key"
  ↳ re-projected to hermes (~/.hermes/.env)
  ↳ re-projected to claude-code (~/.claude/settings.json — replaced stale)
  ↳ re-projected to openclaw (~/.openclaw/openclaw.json)
  ↳ re-projected to zeroclaw (~/.zeroclaw/config.toml)
```

So the user only ever updates the key in **one** place; Foreman handles the propagation.

### Opting out

```bash
foreman agent add my-agent --type hermes --skip-projection
```

For power users who want Foreman to stay strictly out of the agent's startup config.

### Launch commands on the Done screen

The setup wizard's Done screen lists per-agent launch commands sourced from each entry's `secret_projection.launch` field (single string OR array for agents with multiple modes — Hermes `chat` vs `gateway`, OpenClaw `chat` vs `gateway`).

## See also

- [`docs/llm-providers.md`](llm-providers.md) — which provider an agent ends up bound to
- [`docs/services.md`](services.md) — 3rd-party services agents can integrate with
- [`docs/registry-maintenance.md`](registry-maintenance.md) — adding a new agent to the bundled catalog
