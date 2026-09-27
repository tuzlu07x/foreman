# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Per-agent identity tokens on the MCP path** (#618,
  [docs](docs/agent-lifecycle.md#agent-identity-tokens)).
  - `foreman agent add` mints a token, keeps it in the encrypted secret
    store and writes it into the agent's MCP config as
    `FOREMAN_AGENT_TOKEN` in the server's `env` (Claude Code / OpenClaw JSON,
    Codex TOML, Hermes YAML and its MCP wrapper), never as an argument.
    Files that carry it are made owner-only.
  - `foreman mcp-stdio` resolves the agent from the token. `--source`
    without a valid token runs as `untrusted:<id>`: none of that agent's
    allow rules, org role, delegation rights or MCP hub servers, while the
    agent's deny / ask rules, block and pause still apply.
  - `foreman agent rewire [<id>|--all]` gives existing agents a token and
    rewrites their wiring; `foreman agent token rotate <id>` replaces a
    token and cuts off sessions using the old one. `--token-out <file>`
    (0600) covers agents wired by hand.
  - `foreman doctor` (`agent_tokens`) and `foreman start` (an inbox warning)
    name the agents that still need rewiring. Unverified connections are
    audited (`agent:identity`) and raised in the inbox; tokens never are.
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
  reserved `foreman-agent-token:*` names.

## [0.1.6] - 2026-06-01

Last published release. See the
[GitHub releases](https://github.com/tuzlu07x/foreman/releases) for earlier notes.
