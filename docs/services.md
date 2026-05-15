# Services

Services are 3rd-party integrations (Telegram, Discord, GitHub, …) that one or more agents can use. Each service in `registry/services.json` ships with a multi-step setup walkthrough so the user doesn't have to leave Foreman to wire it up.

## Tier-1 services (bundled)

| Service | id | Secret name | Used by | Where to get |
|---|---|---|---|---|
| Telegram | `telegram` | `telegram-bot-token` | hermes, openclaw | [t.me/BotFather](https://t.me/BotFather) |
| Discord | `discord` | `discord-bot-token` | hermes, openclaw | [discord.com/developers/applications](https://discord.com/developers/applications) |
| Slack | `slack` | `slack-bot-token` | openclaw | [api.slack.com/apps](https://api.slack.com/apps) |
| GitHub | `github` | `github-pat` | claude-code, codex | [github.com/settings/tokens/new](https://github.com/settings/tokens/new) |
| Atlassian | `atlassian` | `atlassian-api-token` | — | [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Notion | `notion` | `notion-integration-token` | — | [notion.so/my-integrations](https://www.notion.so/my-integrations) |

`open_url_hotkey: true` on every entry means the wizard / TUI wraps `where_to_get` in OSC 8 escape sequences so a Cmd-click (or Ctrl-click on Linux) opens the page in a browser from supporting terminals (iTerm2, WezTerm, Ghostty, modern GNOME Terminal).

## Setup walkthroughs

Each entry's `setup_steps` array drives the wizard's Step 3 (per-service walkthrough) and the TUI Services page's `[w]` overlay.

### Telegram

1. Open Telegram (phone or desktop)
2. Search for `@BotFather`
3. Send `/newbot`
4. Choose a display name (e.g. "My Foreman Bot")
5. Choose a username ending in `bot` (e.g. `fatih_assistant_bot`)
6. Copy the token BotFather sends — format `123456789:ABC-DEF1234567890abcdef`

### Discord

1. Open the Discord Developer Portal
2. Click "New Application" and name it
3. Bot tab → Add Bot
4. Reset Token → Copy (long opaque string)

### Slack

1. Visit `api.slack.com/apps` and create a new app (From Scratch)
2. Name it + pick a workspace
3. OAuth & Permissions → add scopes (`chat:write` and `channels:read` at minimum)
4. Install to Workspace
5. Copy the Bot User OAuth Token — starts with `xoxb-`

### GitHub

1. Visit `github.com/settings/tokens/new`
2. Note: meaningful name (e.g. "Foreman agent token")
3. Expiration: 90 days recommended
4. Scopes: `repo` (full repo access) + `read:user`
5. Generate token → copy immediately (won't show again) — starts with `ghp_`

### Atlassian (Jira / Confluence)

1. Visit `id.atlassian.com/manage-profile/security/api-tokens`
2. Create API token → name it
3. Copy the token (long opaque string)

### Notion

1. Visit `notion.so/my-integrations`
2. New integration → name it
3. Choose workspace + capabilities
4. Copy the Internal Integration Token — starts with `secret_`
5. Share each Notion page you want the integration to access (per-page grant)

## TUI management

Hotkey `[V]` (Shift+v) opens the Services page. From there:

- `[n]` add a new service (or rotate an existing one)
- `[w]` open the per-service walkthrough overlay
- `[r]` rotate the stored token
- `[d]` remove

## Wiring services to agents

A service shows up under an agent's "Used by" line if it's in that agent's `optional_services` list **and** the reverse mapping `used_by_agents` includes the agent. Both are validated at test time by `validateAgentsAgainstCatalogs` ([`tests/core/cross-catalog-validation.test.ts`](../tests/core/cross-catalog-validation.test.ts)) — drift between the two halves of a reference can't be merged.

## Adding a custom service in v0.1.x

Not user-facing for v0.1.x. Maintainers can append entries to `registry/services.json` per [`docs/registry-maintenance.md`](registry-maintenance.md). User-editable upstream catalogs are v0.2.

## Storage

Service tokens live in the same AES-256-GCM encrypted SQLite store as LLM provider keys. Agents request them via Foreman's MCP `secrets/get` tool, which goes through the policy + audit pipeline.
