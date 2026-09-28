# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.0] - 2026-09-28

Integrations, a local daemon that makes the Claude Code hook fast, a model
picker in the TUI, and fixes from end-to-end QA. There are no breaking
changes. While `foreman start` runs, agents and the hook use its daemon
(`FOREMAN_NO_DAEMON=1` keeps the old in-process path); without it
everything works as before.

### Added
- **One daemon for every agent** ([docs/mcp-hub.md](docs/mcp-hub.md#one-daemon-for-every-agent)).
  While `foreman start` runs, agents' `foreman mcp-stdio` and Claude
  Code's PreToolUse hook connect to its daemon instead of starting Foreman
  themselves. `foreman daemon` runs it without the TUI.
  - `foreman doctor` has a `daemon` row: listening, not running, or why
    agents can't use it (socket path too long, a socket or token file they
    don't trust).
  - Each MCP hub stdio server starts once for all agents; each agent still
    sees only the servers its access list and `org.yaml` allow.
  - The hook answers in about 30 ms instead of about 200 ms (p50 on an
    Apple-silicon Mac; `node scripts/hook-latency.mjs`).
  - Same decisions as before, with the same code. The socket is a 0600
    Unix socket in the state directory (never TCP) with a per-boot token
    in a 0600 file. Agents still prove who they are with their own
    identity token, checked by the daemon.
  - Fail closed: if the daemon stops during a call, the hook blocks it
    (exit 2) and an MCP call gets an error; neither is retried. Without a
    daemon, or with a socket or token file that isn't safe to trust,
    everything runs in the agent's own process as before
    (`FOREMAN_NO_DAEMON=1` forces that). Native Windows keeps the
    in-process path.
- **Integrations** (`foreman integrations`,
  [docs/integrations.md](docs/integrations.md)): GitHub, GitLab, Jira and
  Confluence, Trello, Linear and Notion as managed MCP hub servers.
  - `add` reads the token from a hidden prompt (or `--token-stdin`) or runs
    the browser sign-in, saves the integration disabled, reviews and pins
    its tools, then enables it for the agents you chose (`--agents`,
    `--departments` or `--all-agents`).
  - Read-only by default: write tools are denied until `--read-write`;
    merges and pushes need a person on every call.
  - `list`, `show` (access per agent), `update` (access level, audience,
    products, params, variant, `--tool TOOL=RULE`, `--rotate`), `enable` /
    `disable` (reaches running agents at once), `login` / `logout`,
    `review`, `test`, `remove` (credentials nothing else uses go too) and
    `adopt` for servers added with `foreman mcp add`.
  - A second account is its own server with its own secret
    (`--name github-work` → `github-pat-work`).
  - The TUI has an Integrations page (`i`): add with a token or browser
    sign-in, review, enable / disable, edit the access level and who may
    use it, per-tool rules (`t`, `←→`), remove (asks first).
  - From chat: `/foreman integrations`, `/foreman integration status |
    enable | disable | remove <name>` in Slack and Discord, and
    `/integrations` / `/integration …` to the Telegram approval bot from your
    private chat. Removing asks for a one-time code; changes need an owner
    (`owner_user_ids` for Slack / Discord), land in the inbox, and a
    relaying agent can only read. Credentials never go through chat.
  - The setup wizard has an optional Integrations step (step 5 of 6, after
    Services): pick integrations, the access level (read-only by default)
    and a token for token variants. They're saved disabled for the agents
    picked in the wizard; the Done screen lists `foreman integrations
    review` / `login` for each. GitHub, Atlassian and Notion are no longer
    offered on the wizard's Services step (`services.json` keeps them).
    An existing setup is not reopened for the new step.
  - `foreman doctor` reports enabled integrations that can't work;
    `foreman secrets remove` / `rotate` say when an integration uses the
    secret.

- **MCP hub access lists, confirm rules and live reload**
  ([docs/mcp-hub.md](docs/mcp-hub.md#mcpyaml)).
  - `access: { agents: [...], departments: [...] }` on a server limits it
    to those agents and department members, on top of `org.yaml`
    (`access: {}` = nobody).
  - `tools.confirm` (merges, pushes): a person answers every call; no
    allow rule, "always allow" or low risk score approves it.
  - A running `foreman mcp-stdio` follows `mcp.yaml` and `org.yaml`: it
    sends `notifications/tools/list_changed`, and a call approved after its
    server was disabled or the agent lost access never runs (audited as
    denied). A broken file leaves no hub servers.
  - `foreman mcp add <id> --param host=…` for catalog servers with a
    configurable host (self-managed GitLab). `mcp.yaml` writes are locked
    and atomic and keep your comments.
- **Model picker in the TUI.** `m` on Settings picks Foreman's own model;
  `m` on Agents picks the selected agent's model (or puts it back on the
  default). The list shows the provider's fast / balanced / most capable
  models first, then its live list when a key is stored. A pick runs the
  same `model` command as the console.
- **Integration credentials stay with the hub.** A secret an integration
  server references can't be read by any agent through `secrets/get`,
  whatever `policy.yaml` says, and is never projected into agent files.

### Fixed
- **Approvals whose caller is gone no longer wait to be decided** (#691).
  When Foreman or an agent was killed while a call waited for approval,
  the approval stayed pending for up to 10 minutes: the next TUI session
  offered it, and allowing it recorded a decision for a call that could no
  longer run. The waiting caller now refreshes a heartbeat, and an approval
  whose caller stopped is cancelled (denied) within about 30 seconds. On a
  clean quit, a Claude Code hook call waiting on the daemon is told
  "Foreman is shutting down — blocking the call" instead of "the daemon
  went away".
- **Setup wizard wording, from terminal QA.**
  - The Providers summary asked "Continue to agents?" and the Services
    summary "Continue to install?". They now name the actual next step
    (Foreman's brain, Integrations).
  - The brain picker said Ollama and OpenAI-compatible brains were "coming
    in v0.2". They now say "not supported yet"; `foreman doctor` no longer
    names a version either.
  - Without a network, the brain's model list said only "fetch failed". It
    now says it couldn't reach the provider, as the agent step does.
  - The Done summary counted a stored GitHub token as "1 service github".
    Integrations are listed in their own block, not as services.
  - The Done screen no longer says "No Foreman identity file for
    claude-code (nothing to push)": nothing to push needs no line.
  - The TUI model picker says it couldn't reach the provider for its full
    model list, instead of "live list unavailable (fetch failed)".
  - The Done screen suggests `foreman agent hook install claude-code`
    while Claude Code's PreToolUse hook (checks its Bash, Edit and Read
    calls before they run) isn't installed; it is a separate opt-in.
- **`?` opens help on every page.** Every status bar says `? help`, but
  only Home opened it; on Agents, Settings, Logs, Policy, Sessions,
  Delegations, Inbox and the other pages the key did nothing. It now works
  everywhere except while a page takes typed text, and on the approval
  modal (help decides nothing; Esc goes back to the call).
- **A busy database no longer kills `foreman mcp-stdio` or `foreman start`**
  (#594). When another process held the SQLite lock past the 5 s busy
  timeout, the audit log's background write threw and the process exited
  mid-session: the agent's MCP server went unreachable and the batch it was
  writing, including the row of a call already allowed, was lost. The batch
  is now kept, in order, and retried with a bounded backoff, each failure
  reported on stderr. A failed control-channel drain in `foreman start` is
  reported and retried on the next tick, and a command whose status could
  not be written is not run a second time. Loading `policy.yaml` at start
  waits for another writer instead of failing with "policy.yaml failed to
  parse: database is locked".
- **`foreman agent remove` takes Foreman out of the agent's config.** It
  revoked the agent's token but left the `foreman` MCP server entry (e.g.
  `mcpServers.foreman` in `~/.claude.json`, `mcp_servers.foreman` for Codex
  and Hermes, ZeroClaw's `[[mcp.servers]]` entry and `foreman` bundle) and
  Claude Code's PreToolUse hook behind. Removing an agent from the CLI, the
  TUI (`x`) or by unticking it in the setup wizard now removes that agent's
  own entries, keeps every other server, hook and key and the file's
  permissions, and prints what it removed. A config it can't read, parse or
  that is a symlink is left alone with a note and never blocks the removal
  ([docs/agent-lifecycle.md](docs/agent-lifecycle.md#what-gets-cleaned-up-on-remove)).
- **Current default models.** Gemini's default, `gemini-2.0-flash`, has
  been shut down by Google, so a Gemini brain stopped working; OpenAI's was
  the older `gpt-4o-mini`. The defaults now come from one place,
  `registry/providers.json` (`default_model` plus `model_tiers`: fast,
  balanced, strongest): `claude-haiku-4-5`, `gpt-6-luna` and
  `gemini-3.5-flash-lite`, also for Hermes, OpenClaw and the OpenRouter
  preset. `/foreman model`'s tap-to-copy list follows the tiers and covers
  Gemini. The wizard's live model list now includes GPT-6 models and sorts
  newest first by version (Claude Fable no longer sank below Haiku).
- **`can_call_agents_with_responsibility` is checked.** The starter
  `policy.yaml` uses it, but it was accepted and ignored. A hand-off to an
  agent whose responsibility note is known and isn't on the list now adds
  40 risk points (like the other responsibility rules, it never denies on
  its own; an agent without a note adds nothing).
- **`foreman org check` explains more and fails on a typo.** It names the
  side (`<from>` / `<to>`) that isn't in `org.yaml` and exits 1, accepts a
  role id as well as an agent id, and keeps the chart's own reason for a
  block with the route it allows instead (`next: hand it to cto
  (claude-code), engineer's manager, …`). It checks `policy.yaml` first and
  says when a `cannot_call` rule, a `can_call` list or an `ask` rule
  decides. Hand-off enforcement is unchanged; the docs now say that a
  `can_call` allow doesn't lift a block from the org chart.
- **`foreman agent show` shows the agent's public key.** Text output adds a
  `key:` line with the `ed25519:xxxxxxxx…` fingerprint (the style
  `foreman init` uses for Foreman's own key); `--json` adds `publicKey`
  (hex) and `publicKeyFingerprint`. No private material is printed.
- **`foreman doctor` before `init`.** The `fts5` row said `requests_fts ready`
  before any database existed. It now reports ``FTS5 available (no database
  yet — run `foreman init`)`` until `foreman.db` exists, and only says
  `requests_fts ready` when the real database has the table.
- **LLM budget pricing.** A model missing from Foreman's price table was
  billed at the provider's cheapest rate: Claude Opus 5 or Fable at Haiku
  prices, gpt-5.x at gpt-4o-mini, Gemini 2.5 and 3.x at 2.0 Flash, so the
  hard budget cap tripped 5 to 60 times too late. The tables now carry the
  current models' list prices, and an unknown model is billed at the
  provider's most expensive current rate, so a budget never runs over.
  Claude Opus 4.5 to 4.8 are billed at $5 / $25, not $15 / $75.

- **Ctrl-C quits with exit code 130** in `foreman setup` and at `foreman
  start`'s first-run prompt, like any interrupted command, so scripts can
  tell an aborted setup from a finished one. The prompt used to exit 13.
- **`foreman secrets list` hides agent identity tokens**, as the TUI Keys
  page already did, and `foreman secrets remove` refuses them. Removing one
  silently cut an agent off; `foreman agent token rotate` and `foreman
  agent remove` are the ways to change them.
- **An allowed call's security report no longer says policy asked for
  approval.** `foreman log show` said "policy asked for explicit approval"
  for every call without risk factors. It now says so only when
  `policy.yaml` (or a confirm rule) asked.
- **The help overlay explains the `y` confirmation** that allowing a high-
  or critical-risk call takes.

## [2.0.0] - 2026-09-28

The first release since 0.1.6. The version jumps to 2.0.0 because several
interfaces and defaults changed in ways that can break an existing setup.
Read **Breaking changes** before you upgrade.

### Breaking changes

- **Node 22.12+** is required (see Changed).
- **Agent identity tokens (#618).** Agents wired before this release run as
  `untrusted:<id>` until you run `foreman agent rewire --all` and restart
  them. See the upgrade note under Changed.
- **Webhook signatures (#656).** `X-Foreman-Signature` is now an HMAC-SHA256
  over `<X-Foreman-Timestamp>.<raw body>`, not over the body alone, and
  every POST carries `X-Foreman-Timestamp` (Unix seconds). Receivers that
  verify the old signature reject every delivery until they are updated
  ([docs/notifications.md](docs/notifications.md)).
- **Push URLs (#656).** Slack and Discord webhook URLs and the ntfy server
  must be `https://` (plain `http://` only to this machine), and a URL with
  a user name or password is refused.
- **`foreman agent remove` keeps the agent's program (#657).** It
  unregisters the agent and revokes its key and identity token, but no
  longer uninstalls the binary. `--uninstall` does, and only for agents
  Foreman installed itself.
- **`foreman report` prints a table (#657).** Use `--json` for the digest
  scripts used to read.
- **Relayed `/foreman` commands (#656).** A command an agent relays (for
  example from Telegram) that changes Foreman, such as `stop` or
  `model <x>`, now waits for your approval. Read-only verbs still run at
  once.
- **A broken `policy.yaml` stops `foreman start`** and `foreman wrap` with
  the file, line and reason, instead of a stack trace (#657). A second
  `foreman start` on the same home refuses to run.

### Added

- **Per-agent identity tokens on the MCP path** (#618,
  [docs](docs/agent-lifecycle.md#agent-identity-tokens)).
  - `foreman agent add` mints a token, keeps it in the encrypted secret
    store and writes it into the agent's MCP config as
    `FOREMAN_AGENT_TOKEN` in the server's `env`, never as an argument
    (`FOREMAN_AGENT_TOKEN_FILE`, a 0600 file, works too). Files that carry
    it are owner-only, never written through a symlink or inside a
    project's git work tree; the setup wizard leaves such a config alone
    (no template seed, no projected keys) and says why.
  - `foreman mcp-stdio` resolves the agent from the token. `--source`
    without a valid token runs as `untrusted:<id>`: none of that agent's
    allow rules, org role, delegation rights, secrets or MCP hub servers,
    and no relaying for you (answers, resolutions, state-changing
    `/foreman` commands, untagged approvals), while the agent's deny / ask
    rules, responsibility rules, rate limits, block and pause still apply.
    All untrusted connections share 30 calls a minute and 3 waiting
    approval prompts.
  - `identity.untrusted` in `policy.yaml`: `ask` (default, nothing is
    auto-allowed), `deny` (quarantine) or `allow_wildcards`.
  - `foreman agent rewire [<id>|--all]` gives existing agents a token and
    rewrites their wiring; `foreman agent token rotate <id>` replaces a
    token, always revoking the old one first, and cuts off sessions using
    it. `--token-out <file>` (0600) covers agents wired by hand; the setup
    wizard names that command for agents it has no config to wire
    (generic-mcp), in its install log and on the Done screen.
  - `foreman doctor` (`agent_tokens`) and `foreman start` (an inbox warning)
    name the agents that still need rewiring and token files others can
    read. Doctor counts only agents whose wiring it read and verified; one
    whose wiring it can't see (generic-mcp) gets its own
    `agent_tokens:<id>` warning. Unverified connections are audited (`agent:identity`) and raised
    in the inbox once a day; tokens never are. Tamper protection flags an
    agent reading another agent's wiring or any `/proc/*/environ`.
  - The Claude Code hook skips `mcp__foreman__*` tools only when each
    `foreman` server entry starts the same Foreman install the hook runs
    from (bare `foreman` on PATH, or an absolute path with the same real
    path) with nothing but the agent token in `env`. A look-alike with
    another binary, `FOREMAN_HOME`, `NODE_OPTIONS` or extra keys is gated.
- **OAuth for hosted MCP servers** (#617,
  [docs/mcp-hub.md](docs/mcp-hub.md#oauth-servers)).
  - Mark a remote server `auth: oauth` in `mcp.yaml` (or use
    `foreman mcp add <name> --url <url> --oauth`), then run
    `foreman mcp login <name>`. Foreman discovers the authorization server,
    registers itself as a client, and signs you in in the browser (PKCE
    S256, a one-shot `127.0.0.1` redirect listener with a `state` check).
    `foreman mcp logout <name>` deletes the tokens and revokes them at the
    provider when the server supports it.
  - The hub attaches the bearer token upstream. It refreshes the token
    before it expires and once on a 401, and it saves rotated refresh
    tokens in one write, even when several agents share the session.
    Refreshes, login, logout and `mcp remove` share one lock, so a logout
    is never undone by a refresh already in progress.
  - `foreman mcp list` and `foreman doctor` show whether each server is
    logged in, when its token expires, or that it needs login.
  - Tokens live only in the encrypted secret store. They never appear in
    `mcp.yaml`, CLI output, errors, tool results or the audit log.
    Agents can't read them: `secrets/get` refuses `mcp-oauth-*` names
    whatever the policy says.

- **End-to-end QA suite** (#624, [docs/qa.md](docs/qa.md)).
  - `npm run qa` walks eight user journeys, the Claude Code
    PreToolUse hook among them, with real processes in
    isolated homes, and checks the audit trail each time.
  - CI runs it on Linux and keeps the Markdown report as an artifact.
- **`foreman demo`** (#632). A company of agents works through a day in a
  sandbox while you watch the real TUI: approvals, a blocked poisoned
  instruction, department messages, a budget alert and a report to you.
  - The agents are stand-ins, and they are the only agent CLIs on the
    demo's `PATH`.
  - The demo runs in its own throwaway `FOREMAN_HOME`. No keys are needed,
    and nothing outside a temp folder is touched.
- **TUI as a control surface** ([docs/tui.md](docs/tui.md))
  - A new look: a status header (agents online, approvals waiting,
    unread notifications, today's counts), a tab row for every page, and
    key hints for the page you're on. Panels use rounded frames, and the
    boot banner is a splash that any key dismisses.
  - Approval queue (#614). Every pending approval is kept, oldest deadline
    first; `←`/`→` move between them, and each key decides the one on
    screen.
  - Command console (#612). Press `:` for the same verbs as `/foreman` in
    chat (`status`, `write`, `assign`, `org`, `report`, `llm`, …) plus
    `approve`/`deny`, `open <page>` and `inbox read`. It has history and tab
    completion, and every command is audited.
  - Inbox (#613). Approvals, blocked calls, crashed or missing agents, task
    results, budget alerts and updates are kept with read state. The TUI
    shows an unread badge and toasts; `foreman inbox` works from any shell.
- **Telegram approval bot** (#610, `foreman notify approval-bot`).
  - Approvals go through a second bot that only Foreman holds and polls, so
    no agent ever sees an approval button.
  - Taps are accepted only from your chat and only with the button's HMAC
    tag, and the buttons are removed after the first tap.
  - `foreman doctor` suggests it when Telegram approvals are relayed.
- **Two-way Slack and Discord** (#615, `foreman notify slack-interactive`,
  `foreman notify discord-interactive`).
  - Approval messages get Allow / Deny buttons, and `/foreman` runs the same
    commands as the TUI console.
  - Foreman holds the connection itself (Slack Socket Mode, the Discord
    Gateway, on Node's built-in WebSocket), so no public URL and no new
    dependency are needed.
  - Only the listed user ids can act. Buttons carry HMAC tags, stale buttons
    say so instead of deciding anything, and reconnects back off.
- **Org spend and reports** (#629).
  - `foreman org report marketing month` and `/foreman report marketing month`
    show what a department, role or agent did and what it cost, with no LLM.
  - `foreman usage` shows spend by department, agent or model.
  - Numbers come from OpenTelemetry sent by the agents: `foreman start`
    listens on 127.0.0.1 and keeps counts only. Tasks Foreman starts report
    automatically, and `foreman usage env <agent>` covers the rest. Usage
    printed by an agent CLI is the fallback.
  - Department budgets (`foreman org budget marketing 50 --pause`) alert at
    80% and 100%. With `--pause`, agents can't delegate into a department
    that has spent its budget.
- **Department channels** (#630). Agents talk to each other through
  Foreman, in department rooms, leadership, all-hands and role-to-role
  threads, following the org chart.
  - Agents use the MCP tools `org_post`, `org_read` and `org_report`.
  - You read everything (`foreman org messages`, `comms`) and post as
    yourself (`foreman org tell`, `tell`).
  - `foreman org channel marketing slack "#marketing"` mirrors a channel to
    Slack or Discord with Foreman's bot. Agents never hold the tokens.
- **Approval escalation along reporting lines** (#623,
  [docs/org.md](docs/org.md#approval-escalation)).
  - `approvals.escalate_via_manager: true` in `org.yaml` (or
    `foreman org escalate on`) sends low- and medium-risk approvals to the
    requester's manager agent as a review request on their thread.
  - The review request carries an opaque review id, never the approval id.
    The manager answers with the `org_recommend` MCP tool. You see the
    recommendation, labelled "unverified id", on the TUI approval screen,
    in the inbox and in the chat where the approval waits.
  - It is advice only. It never approves, denies, extends or shortens an
    approval, and it doesn't change the timeout default. Only the
    requester's actual manager can recommend: not a colleague, not the
    requester, not a human source, not a blocked or disabled agent.
  - Arguments sent for review have sensitive keys and inline credentials
    masked. Review requests are never mirrored to Slack or Discord.
  - High and critical approvals always go straight to you. At most one
    review request per report and manager every 30 seconds. Recommendations
    are audited as `org:recommendation`.
- **Grow the org from the CLI:** `foreman org add-department` and
  `foreman org add-role`. Both validate the chart and keep your comments.
- `assign` and `org` chat verbs: route a task through `org.yaml` from
  Telegram or the TUI.
- `NO_COLOR` is honoured by the TUI.
- **MCP Hub** (`foreman mcp …`): connect upstream MCP servers once and every
  agent gets them, with each call mediated (policy, risk, approval, audit).
  - Includes a curated catalog of 19 verified servers.
  - Secrets are referenced as `${secret:…}` and stay out of agent configs.
  - Tool-poisoning scanner, and rug-pull detection that pins tool definitions.
  - Result guard: redacts secrets and flags injected instructions.
  - Lazy tool discovery and result budgets to save tokens.
- **Foreman Org** (`foreman org …`): departments, roles and reporting lines
  for your agents.
  - Starter templates: startup, software-team, solo.
  - Delegation is enforced along the chart.
  - MCP access is scoped per department.
  - `org sync` pushes roles to agents; `org upgrade` updates their runtimes.
- **Notification channels**: Slack, Discord, email (dependency-free SMTP) and
  ntfy phone push.
  - `foreman notify ntfy-setup` and `foreman notify route` commands.
  - All channels are built by one factory, used by both `foreman start` and
    `foreman notify test`.
- **Tamper-protection risk rule**: flags agents touching Foreman's database,
  keys and policy, their own hook or MCP wiring, or mutating `foreman` CLI
  commands.
- `foreman-hook` binary: a lightweight PreToolUse entry that starts about a
  third faster on every Claude Code tool call.
- New `foreman doctor` checks: `notify_channels`, `mcp_hub`, `org`.
- CI:
  - Always-on `verify` gate for every PR (#589).
  - CodeQL scanning.
  - Node 22/24 test matrix.

### Fixed

- **Security fixes from the end-user QA pass** (#656).
  - Agents can't run Foreman: relayed commands that change it need you
    (see Breaking changes), and a `--source` can't create, revive or
    re-spell an agent.
  - Policy edits apply live, without a restart, and rule ids stay stable,
    so audit rows keep pointing at the right rule. A block rule lives in
    `policy.yaml` only and goes away when you remove it.
  - Agent-to-agent rules work: `can_call` / `cannot_call`,
    `<agent>:<tool>` rules and the delegation fields of responsibility
    policies bind hand-offs (`write`, `assign`).
  - The `.env` and SSH-key guards hold whatever a transport calls the tool
    (Hermes, OpenClaw and ZeroClaw report reads as `read`). Deny and ask
    rules cover every alias; allow rules never widen.
  - `rate_limits.tokens_per_hour` is enforced.
  - "Always allow / deny" remembers the call you answered (same agent,
    tool and file or command), not the whole tool, and says so first.
  - Allowing a high- or critical-risk call in the TUI takes a second key
    (`a`, then `y`). Hidden terminal characters in agent text are shown as
    visible symbols, so they can't hide a path on the approval screen.
  - Only your own denials count as "previously denied".
  - Stripe, npm, Notion and Discord tokens are redacted. Secret names are
    validated, `--value` warns about shell history, and
    `secrets show --reveal` is audited.
  - The Claude Code hook honours `FOREMAN_APPROVAL_TIMEOUT`; `mcp-stdio`
    answers `ping` and non-JSON input as JSON-RPC says.
- **CLI and TUI fixes from the end-user QA pass** (#657).
  - `foreman usage env <agent>` gives each agent a usage key of its own,
    so an agent can no longer book its spend to another one.
  - Log search text is never parsed as FTS5 syntax (it used to crash).
  - The TUI asks before deleting a secret or removing an agent, and the
    Keys page never lists or deletes agent identity tokens.
  - `foreman agent add <registry-id>` works without `--type`.
  - `foreman doctor` never creates `secrets.key`, fails loudly when it
    can't decrypt the secrets, checks the policy schema and rule regexes,
    and gives a fresh box no false warnings. `migrate-config` never moves
    the live home.
  - `foreman notify enable` points the channel at its credentials, and
    offline errors say "couldn't reach", not "rejected".
  - The setup wizard and the help overlay fit an 80x24 terminal; `q` and
    Ctrl-C quit the same way on every screen; the wizard warns about a
    token, chat id or endpoint with the wrong shape.
  - Approvals that timed out while `foreman start` wasn't running leave a
    trace in the inbox. `log tail` shows what each call was about, and
    `org messages boss` is your inbox.
- **OpenClaw on an older Node** (#646). OpenClaw needs Node
  `>=24.16.0 <25 || >=26.1.0` since v2026.9.3; Foreman runs on 22.12+.
  When the `node` on PATH is outside that range, the setup wizard,
  `foreman agent add` and `foreman agent update` no longer run
  `npm install -g openclaw`. They print the requirement and OpenClaw's
  upstream installer command for you to run yourself, and the wizard goes
  on with the other agents. `foreman doctor` warns while a registered or
  installed OpenClaw can't run. The range lives in the registry as
  `engines.node`.
- **Agent MCP wiring lands where each agent reads it** (#591, #618):
  - **Claude Code:** the `foreman` MCP server goes into `~/.claude.json`
    (top-level `mcpServers`), where Claude Code reads user-scope servers.
    `~/.claude/settings.json` has no `mcpServers` key; it keeps only the env
    projection and the PreToolUse hook. Config writes keep every other key,
    are owner-only and replace the file in one step. Run
    `foreman agent rewire claude-code` to move an existing install.
  - **Hermes:** the entry goes into the top-level `mcp_servers:` map of
    `~/.hermes/config.yaml`, which is what Hermes reads. Foreman writes it
    directly (command, args and the token env), so the wizard no longer
    runs `hermes mcp add` with a wrapper script, and a stale
    `mcpServers.foreman` from older Foreman versions is removed.
  - **ZeroClaw:** `config.toml` gets a `[[mcp.servers]]` entry named
    `foreman` and a `[mcp_bundles.foreman]` bundle granted to every
    `[agents.<alias>]` (ZeroClaw connects an agent only to its bundles'
    servers). The ignored `[mcpServers.foreman]` table is removed. When the
    file declares no agent alias, `foreman agent add` / `rewire` say how to
    grant the bundle.
  - **Codex:** Foreman no longer writes `preferred_auth_method` into
    `~/.codex/config.toml`; that key is gone from Codex's config schema.
    Nothing replaces it. API keys still go to `~/.codex/auth.json`, and
    ChatGPT sign-in is `codex login`.
- **Opening a browser on Windows** no longer goes through `cmd /c start`.
  A URL with `&` or `|` in it could be cut short there or run a command.
  Foreman now uses `rundll32 url.dll,FileProtocolHandler` with no shell.
  This covers the setup wizard, `foreman llm login` and
  `foreman mcp login`.
- **Standalone binaries** ([docs/install.md](docs/install.md#standalone-binary-no-nodejs), [docs/releasing.md](docs/releasing.md#standalone-binaries)).
  - The pkg build failed on all four targets, and the binary it made could not have run: the MCP SDK's subpath imports were missing, Ink's and yoga-layout's top-level `await` broke, and its small-ICU Node crashes Ink on any non-ASCII text.
  - Each binary is now a Node.js single executable application on the official Node.js 22 build, with the whole CLI bundled in. It's about 130 MB.
  - Every binary is smoke-tested on its own platform: `init`, `doctor`, `mcp-stdio`, the MCP hub, the TUI and `foreman demo`.
- **Claude Code hook:** `mcp__foreman__*` tools skip the hook only when they are tools Foreman actually serves, and no project `.mcp.json` or local-scope config swaps in another `foreman` server. Anything else is gated (#619).
- **MCP hub:** a call withheld as a possible rug pull is logged as denied (`mcp:withheld:<server>`), not as the policy's allow (#635). `foreman mcp tools <server>` shows the rug pull even without `--refresh` (#634).
- **Webhook:**
  - the outcome message carries the approval's `id` and `requestId`, and is sent once instead of on every countdown refresh;
  - the URL must be `https://` (plain `http://` only to this machine) (#636).
- **TUI:** `q` on the approval screen asks to quit; it never decides the approval. Decisions made in the TUI, or in chat, are recorded as `user:tui`, `user:telegram` and so on across processes (migration `0026`) (#637).
- **Security**
  - The Claude Code hook now fails closed. Before, any error (a locked DB, bad
    JSON) let the tool run.
  - The hook now applies `policy.yaml` and writes audit rows.
  - Telegram approvals work end to end. Buttons carry the real approval id plus
    an HMAC tag, and decisions are persisted across processes.
    - A relayed allow, or any policy change, needs the tag.
    - Other agents can no longer approve pending calls by id.
    - Allow tokens are kept out of the message text.
    - See SECURITY.md for the remaining limit with the chat agent itself.
  - LLM verdicts can only make Foreman stricter; a prompt-injected "allow" can
    no longer relax a gate.
  - Secrets are redacted from notifications, the verifier prompt, the security
    report and the audit log.
  - Config and state directories are 0700; the DB and policy files are 0600.
  - Blocked or paused agents are denied on every transport.
  - Policy matching:
    - Invalid regexes fail safe (including `toolPattern`).
    - Paths are normalised and matched case-insensitively across all
      path-like arguments.
    - Restrictive rules apply when any path or command field matches. An
      allow rule applies only when every one does, so `..` and a second
      argument can't ride on an allowed path.
    - Precedence: a rule overrides another only when it is more specific
      on one axis (exact source, conditions) and no less specific on the
      other. Otherwise the stricter one wins. A remembered "always allow"
      still beats a blanket ask, but no longer overrides targeted guards,
      and a wildcard allow can no longer lift a per-agent ask.
  - The default policy also guards `file_write` (Claude Code / Codex writes),
    not only `write_file`. Existing `policy.yaml` files are unchanged; re-run
    `foreman init --reset-policy` or copy the rule to pick it up.
  - The Claude Code hook fails closed through the main `foreman hook` CLI
    too (escaped errors and usage errors exit 2), and it now gates `Grep`
    and `Glob`.
  - The tool scanner detects Unicode tag characters and scans tool names and
    annotations. Pins cover annotations.
  - Upstream MCP start-up errors no longer echo injected secrets to the agent
    or the audit log.
  - Private-key redaction is linear-time and masks keys whose END line was
    cut off.
  - A webhook whose signing secret is missing stays off instead of sending
    unsigned.
  - Fixed a ReDoS in the database-URL secret pattern.
  - SSH key globs and suffixed key names are now detected.
  - A one-time ACP allow can no longer turn into a permanent `allow_always`.
  - A child process printing non-object JSON no longer crashes `foreman start`.
  - Oversized MCP frames are dropped.
  - The secret-projection temp file is no longer predictable.
  - Removed `env` from the curated allowlists.
- **mcp-stdio** (#594)
  - Concurrent message handling.
  - JSON-RPC errors instead of crashing the process.
  - Pending approvals are cancelled and audited when the client disconnects.
- **Notifications**: Slack and Discord were enabled by the wizard but never
  built at runtime.
- **TUI**
  - The TUI no longer denies every approval after 60 seconds on its own
    clock. Previously this also cut 10-minute Telegram approvals short.
  - A second approval no longer replaces the first on screen.
  - Approvals decided elsewhere (a Telegram tap, a timeout in the requesting
    process) now leave the screen.
- `foreman start` no longer crashes when a registered agent's daemon
  binary isn't installed; the inbox says which one and how to fix it.
- **Approvals**
  - Timeouts are audited as `approval-timeout`, and approvals cancelled by a
    disconnect as `approval-cancelled`.
  - Relayed `block_*` taps now inject their rule (the injector was never
    wired). Long rule names use a compact id instead of dropping the button.
- **Misc**
  - Agent-side session ids no longer abort approved calls.
  - The delegation watchdog is cleared on shutdown.
  - The CLI uses `parseAsync`.
  - Pushing a SOUL backs up user-authored identity files.

### Changed

- **Release pipeline** (#620, [docs/releasing.md](docs/releasing.md)).
  - Publishing a GitHub release now publishes to npm with provenance.
  - Each binary is built and smoke-tested on its own architecture (macOS arm64 and x64, Linux x64 and arm64) and ships with `SHA256SUMS`.
  - Every workflow pins its actions by commit SHA.
- Node **22.12+** is required. Node 20 reached end-of-life on 2026-04-30, and
  `ink` 7 / `commander` 15 need Node 22. The installer now sets up Node 22.
- The default Claude Code hook matcher also covers `Read`, `NotebookEdit`,
  `WebSearch` and third-party `mcp__…` tools.
- The MCP SDK floor is raised to 1.30 (lockfile unchanged).
- **better-sqlite3 13** (#644, [supported platforms](docs/install.md#supported-platforms)).
  - The SQLite driver moves from 12.11 to 13.0.3: N-API, SQLite 3.53.4,
    and prebuilt binaries inside the npm package instead of an install-time
    download from GitHub (`prebuild-install` and `bindings` are gone, and
    there is no install script). The binaries are covered by the lockfile's
    integrity hash; the package grows from 2.7 MB to 11.4 MB (27 MB
    unpacked).
  - Supported platforms are macOS, Linux (glibc and musl) and Windows on
    x64 and arm64; Foreman itself runs on Windows through WSL2. Other
    platforms no longer build the driver from source and can't open the
    database.
  - The standalone binaries embed the prebuilt addon for their target
    and load it from the hash-checked runtime directory as before.
- **Upgrade note (#618):** agents wired before identity tokens keep
  working, but as `untrusted:<id>` (lowest privilege) until you run
  `foreman agent rewire --all` and restart them. `mcp-stdio` no longer
  registers unknown `--source` ids on first connection; register agents with
  `foreman agent add`. `foreman secrets show` / `add` / `rotate` refuse the
  reserved `foreman-agent-token:*` names. `--source` must match
  `[A-Za-z0-9._-]{1,64}`. Until rewired, untrusted agents' calls ask for
  approval by default (`identity.untrusted: ask`).

## [0.1.6] - 2026-06-01

See the [GitHub releases](https://github.com/tuzlu07x/foreman/releases) for
the notes of 0.1.6 and earlier.
