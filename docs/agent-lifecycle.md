# Agent lifecycle

Foreman manages each agent from registration through removal. The same operations are available from the CLI (`foreman agent ...`) and from the TUI's Agents page (press `a` on the Home page).

## Lifecycle states

```
                      add
   not registered ──────────▶ active ◀─────────────────┐
                              │    ▲                   │
                      disable │    │ enable            │ unblock
                              ▼    │                   │
                             disabled                  │
                                                       │
   active or disabled ─────────── block ──────────▶ blocked

   any state ─────────────── remove ──────────────▶ not registered
```

`foreman agent list` shows the state as `status=…`:

- **active** — the default after `add`. Its calls go through policy, risk scoring and your approval.
- **disabled** — paused. Every call is refused (`agent:disabled`) and recorded in the audit log, before policy is consulted. The registration, keys, identity token and config stay, so `enable` picks up where it left off.
- **blocked** — refused the same way (`agent:blocked`), for an agent whose behaviour has gone off the rails. `unblock` makes it **active** again, even if it was disabled before.
- **not registered** — after `remove`. Its keypair and identity token are revoked.

<!-- pending: #656/#657 -->
The agent's binary stays installed after `remove` unless you pass `--uninstall`.

An unverified connection that claims a blocked or disabled id is refused too (see [Agent identity tokens](#agent-identity-tokens)).

## CLI surface

<!-- pending: #656/#657 (the `agent add <registry-id>` and `agent remove --uninstall` rows) -->
| Command | Purpose |
|---|---|
| `foreman agent list` | registered agents (including disabled and blocked) and their status |
| `foreman agent add <registry-id>` | register an agent from the bundled catalog (`foreman registry list`); see below |
| `foreman agent add <name> --type <registry-id>` | the same under a name of your own |
| `foreman agent add` | interactive: pick from the catalog |
| `foreman agent show <name>` | the agent row (status, registry entry, transport, identity token) plus its MCP config snippet |
| `foreman agent update [name]` | upgrade an agent's npm package (omit the name or pass `all` for every agent) |
| `foreman agent remove <name> [--uninstall]` | unregister, revoke its keypair and identity token; `--uninstall` also uninstalls the binary |
| `foreman agent rewire [<name>\|--all]` | give the agent its identity token and rewrite its MCP wiring (see [Agent identity tokens](#agent-identity-tokens)) |
| `foreman agent token rotate <name>` | mint a new identity token and rewrite the wiring; the old token stops working at once |
| `foreman agent regenerate-key <name>` | issue a new Ed25519 keypair (revokes the old one) |
| `foreman agent block <agentId>` | refuse and log every call |
| `foreman agent unblock <agentId>` | make a blocked agent active again |
| `foreman agent disable <agentId>` | pause the agent without removing its config |
| `foreman agent enable <agentId>` | make a disabled agent active again |
| `foreman agent responsibility <agentId> [text...]` | set (or, with no text, clear) the responsibility note |
| `foreman agent hook install\|uninstall claude-code` | add or remove Foreman's PreToolUse hook in Claude Code's settings |

<!-- pending: #656/#657 -->
`foreman agent add <registry-id>` (for example `foreman agent add claude-code`) uses the catalog entry with that id. Useful options: `--auto-install` installs the agent when its binary is missing, `--skip-config` leaves its config file alone, `--config-path <path>` writes a config at a non-default path, and `--token-out <file>` also writes its identity token to a file. `foreman agent add --help` lists them all.

`foreman agents` is an alias for `foreman agent`.

## TUI flow

Press `a` on the Home page to open the Agents page:

```
│ Agents                              1 registered · 1 active · 0 crashed · 0 disabled · 0 blocked │
│ ────────────────────────────────────────────────────────────                                     │
│                                                                                                  │
│ ▸ ● generic-mcp (Generic MCP server) · stdio · last 00:44:56                                     │
```

Keys on this page:

| Key | |
| --- | --- |
| `↑` `↓` | select an agent |
| `Enter` | expand it: registry id, status, `--source` key, responsibility note, LLM provider |
| `d` / `e` | disable / enable |
| `b` | block, or unblock a blocked agent |
| `N` | edit the responsibility note |
| `L` | change its LLM provider |
| `o` | run its login (OAuth or interactive setup) |
| `R` | regenerate its keypair; the new private key is shown once |
| `r` | remove it (the registration and its identity token; the binary and the agent's config files are left alone) |
| `Esc` | back to Home |

<!-- pending: #656/#657 -->
`r` asks you to confirm before it removes anything.

The responsibility note is a free-text answer to "why did I install this agent again, 3 months later?" — it surfaces in audit logs, approval prompts, and the dashboard, and `responsibility_policies` in [`policy.yaml`](policy.md#responsibility_policies) check calls against it.

## What gets cleaned up on `remove`

When you remove an agent, Foreman:

1. Deletes the agent's row from the database (with its per-agent settings such as the LLM provider and responsibility note).
2. Revokes its Ed25519 keypair and its identity token. The `foreman` MCP entry left in the agent's config now connects as `untrusted:<id>`, and a new install can't impersonate the removed agent.
3. **Does not** remove the `foreman` MCP entry from the agent's config files (see the table under [Agent identity tokens](#agent-identity-tokens) for where it is), the Claude Code PreToolUse hook (run `foreman agent hook uninstall claude-code` first), keys Foreman [projected](#secret-projection-222--223) into the agent's own files, or anything in the agent's own state dir (`~/.hermes/`, `~/.openclaw/`, etc.).

<!-- pending: #656/#657 -->
4. Leaves the agent's binary installed. With `--uninstall`, it also runs the matching uninstall command (for example `npm uninstall -g @anthropic-ai/claude-code`). An agent installed by a script (like Hermes) can't be uninstalled automatically; Foreman prints a hint instead:

```
note: Hermes was installed via a script — Foreman can't auto-uninstall. Remove the hermes binary manually (try the installer's --uninstall flag).
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

The push is best-effort — some runtimes (notably Hermes' core LLM prompt) weight their built-in system prompt above any user-supplied SOUL.md. The push still gets you the strongest available identity hook for that runtime; whether the upstream LLM respects it is upstream's call. See the archived [v0.1.0 QA report](archive/qa-report-v0.1.0.md) for the original Hermes identity finding.

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
