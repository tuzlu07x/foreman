# Plan: Integrations (GitHub, GitLab, Jira/Confluence, Trello, Linear, Notion)

> Status: approved plan, implementation in progress. PR 1 (catalog + model) has a work-in-progress commit on branch `claude/busy-wright-gn17l6`; PRs 2–5 are not started.

The decisions in §13 are binding for the implementation.

## Core decision
An **integration is a product-level layer over one MCP hub server in `mcp.yaml`**. It is not a new runtime.

Every integration tool call still goes through `foreman mcp-stdio`, then the mediator (policy, risk, approval, audit), then `McpHub`. So pins, the poisoning scan, the result guard and secret scrubbing all still apply. There is **no new DB table and no migration in v1**:
- `mcp.yaml` is the single source of truth.
- Credentials live in the encrypted `secrets` table.
- The OAuth session is `mcp-oauth-<server>`.
- Pins stay in `mcp-pins.json`.
- History goes to `audit_events`, and chat-change notices to `inbox_items`.

## 0. Today's state
- **Bundled catalog** (`registry/mcp-servers.json`):
  - It has GitHub (remote PAT: `https://api.githubcopilot.com/mcp/`, `Authorization: Bearer ${secret:github-pat}`), Notion, Sentry and others.
  - It is missing GitLab, Jira/Atlassian, Trello and Linear.
  - `McpCatalogEntrySchema` (`src/core/mcp-hub/catalog.ts`) has no `auth: oauth` and no URL parameters.
- **GitHub tool rules are stale.** The current server has consolidated tools (`issue_read`, `issue_write`, `pull_request_read`, …), and the allow globs miss `*_read`.
- **The hub is loaded once per `mcp-stdio` process** (`loadHub` in `bootServices`, `src/cli/mcp-stdio.ts`), so editing `mcp.yaml` doesn't reach running agents. That is a security gap for "disable".
- **Access:** `scopeForAgent` (`src/core/mcp-hub/boot.ts`) calls `allowedMcpServers` (`src/core/org/org.ts`), which only limits per role or department through `org.yaml`. Without `org.yaml`, every verified agent sees every enabled server; `untrusted:<id>` sees none.
- **`saveHubConfig`** writes with `writeFileSync` directly: no lock, not atomic, and comments are dropped.
- **Services overlap:** `registry/services.json` has `github` (`github-pat`), `atlassian` (`atlassian-api-token`) and `notion`. These are plain secrets that the wizard Services step and the Services page (`V`) manage.
- **Secrets:** `secrets/get` is deny-by-default (`policy.evaluateSecretAccess`), and `mcp-oauth-*` is hard-reserved (`MediatorService.handleSecretGet`).
- **Chat:**
  - Slack Socket Mode (`slack-socket.ts`) and Discord Gateway (`discord-gateway.ts`) check `allowed_user_ids`, then call `runChatCommand` in `src/cli/start.ts` → `ForemanCommandRouter` with `trustedOwner: true`.
  - The Telegram approval bot (`telegram.ts`, `pollApprovalBot`) handles only button taps and `/start`. It already enforces `from.id === chat.id === chat_id`.
  - Commands sent to the main Telegram bot arrive only as agent relays (`submit_command`).
- **#656 (`fix/qa-sec`)** adds `relayedCommandAccess`, `requireHuman` and the owner-surface verb class. Chat and `confirm` depend on it.
- **Audit:** `foreman mcp add/remove/enable/disable` write no audit events today.

## 1. MCP server choices
| Product | First choice | Transport / URL | Auth | Fallback |
|---|---|---|---|---|
| GitHub | Official `github/github-mcp-server`, remote | Streamable HTTP `https://api.githubcopilot.com/mcp/`; headers `X-MCP-Toolsets`, `X-MCP-Tools`, `X-MCP-Readonly`, `X-MCP-Lockdown` | PAT via `Authorization: Bearer` (OAuth has no DCR, so it isn't supported yet). Add `X-MCP-Lockdown: true` by default. | Local docker `ghcr.io/github/github-mcp-server` (pin the digest). Env `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_TOOLSETS`, `GITHUB_READ_ONLY`, `GITHUB_HOST`. |
| GitLab | GitLab built-in MCP (Beta) | `https://<host>/api/v4/mcp`; optional header `X-Gitlab-Enabled-Mcp-Server-Toolsets` | OAuth 2.0 with DCR, `mcp` scope. Host parameter defaults to `gitlab.com`. | Community `@zereight/mcp-gitlab` (stdio): `GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_API_URL`, `GITLAB_PERMISSION_MODE`, `GITLAB_TOOLSETS`. |
| Jira / Confluence | Atlassian Rovo MCP (official remote) | `https://mcp.atlassian.com/v1/mcp` (check whether `/v2/mcp` has replaced it in PR 1) | OAuth 2.1 with DCR, or an API token as `Authorization: Basic base64(email:token)` if an admin has enabled that | Community `sooperset/mcp-atlassian` (`uvx mcp-atlassian`) for Server/DC: `JIRA_URL`, `JIRA_USERNAME` + `JIRA_API_TOKEN` or `JIRA_PERSONAL_TOKEN`, `READ_ONLY_MODE`. |
| Trello | Official Trello MCP (Atlassian) | `https://mcp.trello.com/v1` (confirm DCR in PR 1) | OAuth | Community `@delorenj/mcp-server-trello`: `TRELLO_API_KEY`, `TRELLO_TOKEN`. |
| Linear | Official remote | `https://mcp.linear.app/mcp` | OAuth 2.1 with DCR, or an API key via `Authorization: Bearer` | none needed |

- Never switch URLs to get read-only on OAuth variants: tokens are bound to the URL (RFC 8707). Enforce read-only with Foreman `tools.deny`, plus server headers only where they don't change the URL.
- Direct-API fallback, for products without MCP: a Foreman-maintained stdio MCP server declared as an ordinary catalog entry. No launch product needs it.

## 2. Data model: schema additions in `src/core/mcp-hub/config.ts` (`ServerConfigSchema`)
```ts
const AccessSchema = z.object({
  agents: z.array(z.string().regex(AGENT_ID_RE)).max(200).optional(),
  departments: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/)).max(100).optional(),
}).strict(); // absent = every verified agent (today); present = listed agents + members of listed departments; {} = nobody
const IntegrationMetaSchema = z.object({
  id: z.string().regex(SERVER_NAME_RE), variant: z.string().regex(/^[a-z0-9-]{1,32}$/),
  access_level: z.enum(["read-only", "read-write"]),
  products: z.array(z.string()).optional(),
  params: z.record(z.string(), z.string().max(200)).default({}),   // non-secret, e.g. host
  secrets: z.record(z.string(), z.string()).default({}),           // slot -> secret-store NAME, never a value
  tool_overrides: ToolRulesSchema.default({}),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict();
// ServerConfigSchema += access?: AccessSchema, integration?: IntegrationMetaSchema
// ToolRulesSchema += confirm?: GlobList   (requireHuman, §8)
```
- **Mapping:** integration to hub server is 1:1, and the server name is the tool namespace (`github__issue_write`). A second account is a second server (`github-work`, secret `github-pat-work`).
- **Rendered `tools`:** catalog server rules ⊕ access-level rules ⊕ denies for unselected products ⊕ `tool_overrides`, with precedence deny > confirm > ask > allow. Re-render on every update.
- **Write path `updateHubConfig(paths, edit)`:**
  - lock `mcp.yaml.lock` (reuse `withLockFile` from `oauth-lock.ts`);
  - read, apply the pure edit, validate;
  - write a 0600 temp file, fsync, rename;
  - keep comments via YAML `parseDocument` (see how `org-cli.ts` does it);
  - switch the `mcp-cli.ts` read/save pairs to this helper.

## 3. Catalog: new `registry/integrations.json`
`mcp-servers.json` stays the transport catalog.

**Entry shape:**
- Fields: id, name, aliases, category (`code | project | docs | observability | chat`), description, homepage, `used_by_agents`, products `[{id, label, tools}]`, `health_check {tool}`.
- Each variant has id, label, server, recommended, auth, `default_access_level` and `access_levels`. Each access level lists `tools` (plus `headers`/`env` only, never url, command or args).

**Auth kinds:**
- `none`;
- `secrets`: fields `[{secret, label, where_to_get, format_hint, pattern?, setup_steps[]}]`;
- `basic`: stores base64(user:pass) as one secret for `Authorization: Basic ${secret:…}`;
- `oauth`: the server entry must have `auth: "oauth"`.

**Changes to `mcp-servers.json` / `McpCatalogEntrySchema`:**
- add `auth: "oauth"`;
- add `user_params: [{name, label, default?, example, pattern}]`, used as `${param:host}` and substituted at add time;
- secret specs gain `format_hint?` and `pattern?`;
- `serverConfigFromCatalog(entry, extraArgs, params)`, whose result must still pass the https check.

**New catalog entries:** `gitlab` (host pattern `^[a-z0-9.-]+(:\d{1,5})?$`), `gitlab-community`, `atlassian`, `atlassian-token`, `mcp-atlassian`, `trello`, `trello-community`, `linear`, `linear-token`, `github-docker`.

**Fix `github`:**
- add `*_read` to allow;
- `confirm: [merge_*]`;
- add `X-MCP-Lockdown: "true"`.

**Validation** (`src/core/integrations/catalog.ts`, the cross-catalog test, and `foreman registry validate`):
- `variant.server` exists;
- `oauth` requires an http server with `auth: oauth`;
- every field secret is declared on its server;
- every `${param}` is declared;
- access levels may not change url, command or args;
- no `allow: ["*"]` or `ask: ["*"]`;
- aliases are unique;
- `used_by_agents` are known agents;
- secret names don't collide with notify.yaml tokens.

## 4. CLI: `src/cli/integrations-cli.ts`, `foreman integrations` (alias `integration`)
| Command | Behaviour |
|---|---|
| `catalog [--json]` | lists the catalog |
| `list [--json]` | configured integrations with state |
| `add <id> [--variant v] [--name n] [--read-only\|--read-write] [--param k=v] [--products …] (--agents a,b [--departments d] \| --all-agents) [--token-stdin] [--no-review] [--disabled]` | flow below |
| `show <name> [--json]` | details, per-agent effective access with reasons, last change |
| `update <name> [--read-only\|--read-write] [--agents …\|--all-agents] [--departments …] [--products …] [--param k=v] [--variant v] [--rotate <slot>] [--tool <tool>=allow\|ask\|confirm\|deny\|default]` | a variant or param change resets pins and needs review or login |
| `enable` / `disable <name>` | disable reaches running agents via live reload |
| `remove <name> [--keep-secrets] [--yes]` | confirms first; removes the block, pins, OAuth (best-effort revoke) and secrets no other server uses; prints a revoke link |
| `login` / `logout <name>` | reuse the OAuth helpers, extracted to `src/core/mcp-hub/oauth-cli-shared.ts` |
| `review <name> [--include-flagged]` | connect, scan, pin, print tools |
| `test <name>` | connect and call the health check |
| `adopt <server>` | turn an existing `foreman mcp add` server into an integration |

**`add` flow:**
1. Read credentials from a hidden prompt or `--token-stdin` (never as an argument).
2. Write the server with `enabled: false`.
3. Log in via OAuth if needed.
4. Review.
5. Enable.
6. Roll back on failure.

Non-TTY `add` requires `--agents` or `--all-agents`. All writes go through `IntegrationService` and are audited with `via: "cli"`.

## 5. TUI page: `src/tui/pages/integrations-page.tsx`
- **Placement:** tab "Integrations", hotkey **`i`**, after Services in `TABS` (`src/tui/components/app-header.tsx`). Add it to `TuiPage` and to `PAGE_ALIASES` in `src/tui/tui-commands.ts`.
- **List row:** `● GitHub  official · token  read+write  41 tools · 3 ask`. Status icons: ● enabled, ○ disabled, ⚠ needs attention (login, withheld tools). An "Available:" row sits at the bottom. Footer: `[↑↓] move · [Enter] details · [n] add · [e] edit · [space] on/off · [t] tools · [r] review · [o] sign in · [d] delete · [Esc] back`.
- **Expanded row:** server, auth (secret names ✓, OAuth expiry), access level, effective access per agent with reasons, tools (available / ask / confirm / quarantined with reasons), last change (from audit, e.g. "via slack U0123").
- **Add flow:**
  1. Product.
  2. Variant, only if there is more than one.
  3. Params (validated).
  4. Products (Atlassian multi-select).
  5. Access level (read-only default).
  6. Who can use it (multi-select of agents, pre-selected from `used_by_agents`, plus "Everyone verified" and departments when `org.yaml` exists).
  7. Credentials (password input with a `where_to_get` link) or OAuth (overlay with URL, `openInBrowser` and a spinner; Esc cancels).
  8. Review (tool table).
  9. `[Enter] enable` or `[Esc] keep disabled`.
- **Edit:** menu with access level, who can use it, products, credentials (rotate or re-login), params, variant. Param and variant changes warn about re-review.
- **Delete:** a confirm overlay listing exactly what goes, with a "keep credentials" toggle and the revoke link.
- **Tools:** list with effective rules; `←→` cycles allow/ask/confirm/deny/default and writes `tool_overrides`. Trusting a flagged tool needs a second confirm and is never allowed from chat.
- **Design:** use the rounded-border `PageHeader` pattern from `services-page.tsx`, the theme's semantic colours, and a compact 1-row form under 80 columns. Pure transitions go in `src/tui/integrations-page-logic.ts`.
- **`app.tsx`:**
  - add the route;
  - add the page to the `n`-is-not-inbox exception, the `pageEditing` gate and the page-owns-input short-circuit;
  - update the help overlay.
- **Keys/Services:** Keys ownership gains the `integrations` kind, and removing a secret from Services or Keys warns if an integration uses it.

## 6. Chat commands (Telegram, Slack, Discord)
**Router:** new verbs in `src/core/foreman-command.ts`, `integrations` (list) and `integration <sub>`. The logic goes in `src/core/integrations/chat.ts`.

| Syntax | Effect | When relayed by an agent (`submit_command`) |
|---|---|---|
| `/integrations`, `/integration list` | list | read, runs |
| `/integration status <name>` | details (names and presence only) | read, runs |
| `/integration enable <name>` | enable | refused (owner-surface) |
| `/integration disable <name>` | disable | refused (owner-surface) |
| `/integration remove <name>` then `/integration remove <name> confirm <CODE>` | remove | refused (owner-surface) |
| `/integration add\|update\|login …` | replies "do this in the TUI (`i`) or `foreman integrations add <id>` on the host" | refused |

Credentials are never accepted in chat.

**Owner surfaces** (`ctx.trustedOwner`):
- Slack and Discord two-way, restricted to `owner_user_ids` (§13).
- The TUI console.
- The Telegram approval bot, as a new owner surface:
  - accept only when `from.id === chat.id === chat_id`, the chat is private and the sender is not a bot;
  - strip `@botname`;
  - accept `/integrations`, `/integration …` and `/foreman …`;
  - call `setMyCommands` once.

**Relayed commands:** in `relayedCommandAccess`, `integrations` and `integration list|status` are read; everything else is owner-surface.

**Wiring:**
- `onChatCommand` in `channel-factory.ts` and `start.ts` gains `telegram`.
- Slack keeps `/foreman integration …` and also maps `/integrations` and `/integration`.
- Discord registers `/integrations` and `/integration` with subcommands and options.

**Remove confirmation** (`src/core/integrations/confirmations.ts`): the code lives in memory in `foreman start`. It is random, single-use, expires after 120 s, is bound to (channel, userId, action, server), and a mismatch invalidates it.

**Enable from chat is refused** when the integration is not reviewed for its current fingerprint, secrets are missing, or it needs a login. On success, the reply lists any withheld tools.

**Output:** plain text. Telegram has no parse mode and clips at 3900 characters; Slack uses `escapeSlack` and clips at 3500; Discord clips at 1900.

**Name resolution:** exact server name, then integration id, then alias. An ambiguous name asks "which one?".

Every chat-originated change also writes an inbox item ("Jira disabled from Slack by U0123").

## 7. Setup wizard step (optional, skippable)
- **Step order:** add `"integrations"` after `"services"`, before `"chat-primary"`, in `STEPS` (`src/tui/setup-state.ts`).
- **Welcome and progress:** Integrations becomes step 5 (optional) and Install becomes step 6 (`welcome.tsx`, `progress.ts`).
- **Upgrade migration:** in `loadSetupState`, if a later step is completed but `integrations` is not, mark `integrations` completed so existing users are not reopened into the wizard.
- **Flow:**
  - multi-select picker, where empty + Enter skips;
  - per integration: recommended variant, then access level (read-only default), then credentials or OAuth (`[o]` now, `[l]` later);
  - access defaults to the agents chosen in the wizard.
- **Persistence:**
  - save through `IntegrationService.add(…, { via: "wizard" })`;
  - only ids go into `WizardSessionSnapshot.integrationsSelected`;
  - OAuth-later integrations are saved disabled, and the Done screen lists the `login` hints.
- **Review:** runs with a spinner; on failure, keep the integration disabled.
- **New files:** `setup-wizard/integrations.tsx` and `integrations-logic.ts`. Each module stays under 600 lines.

## 8. Policy, approval, audit
- **Default tool rules:**
  - reads allow (`get_*`, `list_*`, `search_*`, `*_read`);
  - deletes deny;
  - everything else has no rule, which means ask.
- **Read-only access** is enforced with `tools.deny` on write globs; `policy.yaml` still wins, and risk rules still escalate.
- **`tools.confirm`:** critical tools such as `merge_*`, `push_files` and `*_repository` pass `requireHuman` (from #656) to `mediator.handleRequest`. Policy may deny them, but no allow rule, "always allow" or low risk score can approve them.
- **Overrides:** per-integration allowlists live in `tool_overrides`; per-agent tightening stays in `policy.yaml`.
- **MCP annotations** (`readOnlyHint`) are never trusted.
- **Hub-only secrets:**
  - `MediatorService.handleSecretGet` denies (`reserved:integration`) any secret referenced by an integration server, whatever the policy says;
  - `agent-secrets-projector.ts` skips them;
  - doctor warns about collisions;
  - rendering refuses literal credential-shaped header or env values.
- **Rotation:** rotating a hub secret bumps `integration.updated_at`, and the hub reconnects.
- **Audit events** (never values):
  - events: `integration:added|updated|removed|enabled|disabled|access-changed|reviewed|login|logout|command-refused`;
  - payload: `{ integration, server, variant, via: cli|tui|wizard|slack|discord|telegram, actor, changes, secrets: [names] }`;
  - `mcp:call` gains an `integration` field.

## 9. Access enforcement
**Rule:** agent X sees and calls server S only if all of these hold:
- X is verified;
- S is enabled;
- the `org.yaml` restriction (`allowedMcpServers`) allows S;
- S has no `access` block, or X is in `access.agents`, or X belongs to a department in `access.departments`.

Department membership is resolved through `rolesForAgent`; an invalid `org.yaml` closes department grants. Access is the intersection of the two layers, and it is **not** written into `org.yaml`.

**Where it is enforced:**
- `scopeForAgent(orgPath, agentId, hubConfig)` in `boot.ts`;
- `McpHub.visible()` for listing;
- `resolveCall` for calls.

**New `HubRuntime`** (`src/core/mcp-hub/runtime.ts`, used by mcp-stdio):
- stats `mcp.yaml` and `org.yaml` before `tools/list` and `tools/call`, throttled to 1 s (mtime + size + inode);
- rebuilds the hub and scope when either changed;
- retires the old hub once its in-flight calls finish;
- an invalid file means no hub servers (fail closed);
- advertises `tools.listChanged` and sends `notifications/tools/list_changed`.

**Check after approval:** in `handleHubCall`, after the call is allowed, re-check that the server is still enabled and in scope. If not, amend the decision to denied (`integration:disabled`).

**Defaults:** legacy servers without `access` behave as today. New integrations always require an explicit access choice.

## 10. Tests
**Core:**
- `tests/core/integrations/catalog.test.ts`: parse and validation rules.
- Extend `tests/core/cross-catalog-validation.test.ts`.
- `tests/core/mcp-hub/units.test.ts`:
  - param substitution rejects `gitlab.com@evil.com`, `a.com/#` and `http://`;
  - schema;
  - `updateHubConfig` is atomic and locked (concurrent writers).
- `tests/core/integrations/service.test.ts`:
  - CRUD;
  - rollback;
  - shared secrets are kept on remove;
  - audit payloads never contain a secret value;
  - a variant change resets pins;
  - rotation bumps `updated_at`.
- `tests/core/mcp-hub/scope.test.ts`.
- `tests/core/mcp-hub/runtime.test.ts`.

**mcp-stdio and hub:**
- `tests/cli/mcp-stdio-hub-reload.test.ts`:
  - disable drops the tool from the next `tools/list`;
  - `list_changed` is sent;
  - a pending approval followed by disable is refused and amended.
- Extend the mediator secret-get tests.
- Extend `tests/cli/mcp-hub-e2e.test.ts` (`demo-server.mjs` fixture, per-agent access, a `confirm` tool).

**Chat:**
- `tests/core/integrations/chat.test.ts`:
  - parse and aliases;
  - owner-surface refusal;
  - confirm code single use, TTL, bound to the user;
  - enable refused when not reviewed;
  - clipping.
- `foreman-command` `relayedCommandAccess`.
- mcp-stdio: a relayed `submit_command integration disable` is refused.
- Telegram approval-bot commands (from.id mismatch, group chat, `@bot` suffix).
- Slack and Discord mappings.

**CLI and TUI:**
- `tests/cli/integrations-cli.test.ts`.
- `tests/tui/integrations-page-logic.test.ts`, plus an ink render smoke test.
- The `app-header` tab.
- The `setup-state` upgrade.
- The wizard step render.

Inject the catalog in tests. Don't add a production env var that overrides it.

## 11. Phasing (5 PRs)
1. **Catalog + model** (no UI):
   - `registry/mcp-servers.json` (new entries, GitHub fix);
   - new `registry/integrations.json`;
   - `mcp-hub/catalog.ts` (auth, `user_params`, params);
   - `mcp-hub/config.ts` (integration block, `updateHubConfig`);
   - `src/core/integrations/{catalog,render,resolve,status,service}.ts`;
   - `registry-cli.ts` (validate);
   - `mcp-cli.ts` (locked writer).
2. **Hub enforcement** (gets a security review):
   - `access` + `confirm` schema;
   - `boot.ts` `scopeForAgent`;
   - `runtime.ts`;
   - `hub.ts`;
   - `mcp-stdio.ts` (runtime, `listChanged`, check after approval, `requireHuman`);
   - `mediator.ts` hub-only secrets, the projector, `org.ts` department helper;
   - docs: `mcp-hub.md`, `SECURITY.md`.
3. **CLI and docs:**
   - `integrations-cli.ts`, `index.ts`;
   - `integrations/verify.ts`;
   - the shared OAuth helpers;
   - doctor `integrations` check;
   - rotate/remove warnings in the secrets CLI;
   - docs: `docs/integrations.md` (new), README, CHANGELOG, a pointer in `docs/services.md`.
4. **TUI page and wizard step:** as described in §5 and §7.
5. **Chat commands:** as described in §6. Also `start.ts` inbox notices, a read-only view for relayed `integrations` in mcp-stdio, `identity-template.ts`, TUI console completion, and `docs/notifications.md` + SECURITY.md.

## 12. Risks
- OAuth limits:
  - GitHub remote OAuth has no DCR, so it is PAT only;
  - static client or CIMD support is a later feature;
  - Atlassian DCR works only for allowlisted domains;
  - GitLab self-managed can turn DCR off.
- Headless OAuth needs `ssh -L` port forwarding; document it.
- Tool globs drift as servers rename tools. Pins and default-ask mitigate this.
- Each `mcp-stdio` starts its own stdio fallback servers (existing limitation).
- Agents' own direct integrations (user-scope MCP servers, `gh`) bypass Foreman. Doctor can hint at them.

## 13. Coordinator decisions (binding)
1. **Hub-only secret enforcement** applies to integration-managed servers, including adopted ones. Legacy `foreman mcp` servers are unchanged.
2. **Services:** GitHub, Atlassian and Notion leave the wizard Services step for the Integrations step. `services.json` keeps them only for backward compatibility, and the Services page shows "managed in Integrations (i)".
3. **Slack/Discord:** add optional `owner_user_ids` (a subset of `allowed_user_ids`). Mutating integration commands require the sender to be in `owner_user_ids`; if it is unset, `allowed_user_ids` applies and doctor warns when that list has more than one id.
4. **Telegram approval-bot commands** are on by default whenever the approval bot is configured (DM only, `from.id === chat.id === chat_id`).
5. **GitHub** has `X-MCP-Lockdown: true` by default. New integrations default to read-only in the wizard and TUI.
6. **Commits:** author and committer `tuzlu07x <86893131+tuzlu07x@users.noreply.github.com>`, no Co-Authored-By, one trailer `Claude-Session: https://claude.ai/code/session_01R2BGVYNeWvEE718XUPwLML`.
