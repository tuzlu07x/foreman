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
- **uninstalled** — not registered. The agent binary stays on disk: `remove` only uninstalls it when you pass `--uninstall`, and only a binary Foreman installed itself.

## CLI surface

| Command | Purpose |
|---|---|
| `foreman agent list` | tabular list of registered agents + state |
| `foreman agent add [name]` | register an agent (looks up `registry/agents.json` if `name` is provided) |
| `foreman agent show <name>` | full record — id, public key, state, config path, registered secrets |
| `foreman agent update [name]` | re-fetch registry entry + re-inject MCP block |
| `foreman agent remove <name> [--uninstall]` | unregister + strip MCP block from config; `--uninstall` also uninstalls a binary Foreman installed |
| `foreman agent rewire [<name>\|--all]` | give the agent its identity token and rewrite its MCP wiring (see [Agent identity tokens](#agent-identity-tokens)) |
| `foreman agent token rotate <name>` | mint a new identity token and rewrite the wiring; the old token stops working at once |
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
3. Revokes the Ed25519 keypair and the agent's identity token — even if the binary is left on disk, a new install can't impersonate the removed agent.
4. **Does not** delete the agent's own config files outside the MCP block, the agent's binary (unless you pass `--uninstall` and Foreman installed it via `npm`/`brew`), or anything in the agent's own state dir (`~/.hermes/`, `~/.openclaw/`, etc.).

For script-installed agents like Hermes, `remove --uninstall` prints the manual uninstall hint:

```
Remove the hermes binary manually (try the installer's --uninstall flag).
```

## Agent identity tokens

On the MCP path, `foreman mcp-stdio --source <id>` names the agent, and the
agent's **identity token** proves it (#618). Without the token, anything that
can edit an agent's MCP config could claim another agent's id and inherit its
policy rules and org role.

- `foreman agent add` mints a token, keeps it in the encrypted secret store
  under a reserved name (`foreman-agent-token:<id>`), and writes it into the
  agent's MCP wiring as the `FOREMAN_AGENT_TOKEN` environment variable, never
  as an argument:

  ```json
  "foreman": {
    "command": "foreman",
    "args": ["mcp-stdio", "--source", "claude-code"],
    "env": { "FOREMAN_AGENT_TOKEN": "fat_…" }
  }
  ```

  The entry goes where each agent reads its MCP servers:

  | Agent | File | Where |
  | --- | --- | --- |
  | Claude Code | `~/.claude.json` | top-level `mcpServers.foreman` (user scope; `settings.json` is not an MCP config) |
  | Codex | `~/.codex/config.toml` | `[mcp_servers.foreman]` and `[mcp_servers.foreman.env]` |
  | Hermes | `~/.hermes/config.yaml` | top-level `mcp_servers.foreman` (Foreman writes it; no `hermes mcp add` step) |
  | ZeroClaw | `~/.zeroclaw/config.toml` | a `[[mcp.servers]]` entry named `foreman`, a `[mcp_bundles.foreman]` bundle, and `"foreman"` added to `mcp_bundles` of every `[agents.<alias>]` (an agent without the bundle connects to no MCP server) |
  | OpenClaw | `~/.openclaw/openclaw.json` | `mcp.servers.foreman` |

  A `foreman` entry an older Foreman left under a key the agent doesn't
  read (e.g. `mcpServers` in Hermes' config) is removed. Files that carry a
  token (configs, the wrapper script, `--token-out`) are owner-only (0600,
  tightened again on every rewire even when the entry is current), replaced
  in one step (temp file and rename) and keep every other key. Foreman
  refuses to write a token through a symlink, or into a file inside a
  project's git work tree (where it could be committed); a dotfiles repo at
  your home directory is allowed with a warning to keep the file ignored.
  When `foreman setup` refuses an agent's config file this way, it leaves
  the file alone (no template seed, no projected keys) and says why; fix it,
  then run `foreman agent rewire <id>` and `foreman secrets repush <id>`.
  `foreman doctor` flags token files others can read, and tamper protection
  flags an agent reading another agent's wiring or any `/proc/*/environ`.
- `foreman mcp-stdio` reads the variable (trimmed once), removes it from its
  own environment (so nothing it starts inherits it), and compares it in
  constant time with the stored token. It re-checks before every message,
  so a rotation takes effect in running sessions too; a store error means
  untrusted, never trusted. Instead of the variable, an agent can set
  `FOREMAN_AGENT_TOKEN_FILE` to a 0600 file holding the token (a symlink or
  a file others can read is ignored), which keeps the token out of
  `/proc/<pid>/environ`.
- **No token, a wrong token, or another agent's token** runs the connection
  as `untrusted:<claimed id>`, the lowest privilege there is: none of the
  claimed agent's allow rules, nothing auto-allowed by default (see
  `identity.untrusted` below), no secrets, no org role, no delegation, no MCP hub servers, and no "always
  allow" remembered for it. The claimed agent's deny and ask rules and its
  `block` / `disable` and its rate limits (counting calls under both ids)
  still apply, so dropping the token never loosens anything. All untrusted
  connections together get at most 30 calls a minute and 3 approval
  prompts waiting at once, so cycling claimed ids can't flood you with
  prompts. The relay tools that act for you are closed to it too:
  `submit_user_answer`, `submit_resolution`, `submit_command` other than
  read-only verbs (`help`, `status`, `org`, `spend`, `activity`), and
  `submit_approval` without the tag from a Foreman button. Human ids (`cli`,
  `tui`, `telegram`, …) stay refused outright.
  Foreman warns on stderr, in the inbox and in the audit log
  (`agent:identity` events; the inbox keeps one item a day for all untrusted
  connections); the token itself is never printed or logged. `--source`
  must be letters, digits, `.`, `_` or `-` (at most 64); anything else is
  refused, and ids are shown without control characters.
- `foreman agent show` says whether the agent has a token (and when it was
  issued) and shows the snippet with a placeholder. `foreman secrets show`
  refuses agent tokens, and so does the MCP `secrets/get` tool.
- `foreman agent remove` revokes the token.

**Quarantine or relax untrusted connections** in `policy.yaml`:

```yaml
identity:
  untrusted: ask   # default: every call they make comes to you
  # untrusted: deny            # refuse them outright
  # untrusted: allow_wildcards # `source: "*"` allow rules apply to them
```

In every mode the claimed agent's denials, block, pause and rate limits
still bind the connection.

**Upgrading an install from before tokens.** Existing agents keep working,
but as `untrusted:<id>` until they are rewired. `foreman doctor` (the
`agent_tokens` check) and `foreman start` (an inbox warning) say which ones.
Fix them all at once, then restart the agents:

```bash
foreman agent rewire --all
```

`rewire` keeps an agent's current token if it has one, so it is safe to run
again. For an agent Foreman can't wire itself (a custom MCP client, or a
config at a non-default path), write the token to a file and set it in the
client's MCP server env yourself:

```bash
foreman agent rewire my-bot --token-out ~/my-bot.token    # 0600
foreman agent rewire claude-code --config-path ~/.config/my-claude/.claude.json
```

**Rotating.** `foreman agent token rotate <id>` mints a new token and
rewrites the wiring. Sessions still running with the old token drop to
untrusted immediately; restart the agent to pick up the new one.

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
| Codex | `~/.codex/auth.json` (`OPENAI_API_KEY`) | flat JSON |
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
