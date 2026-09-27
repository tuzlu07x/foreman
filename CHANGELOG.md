# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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

## [0.1.6] - 2026-06-01

Last published release. See the
[GitHub releases](https://github.com/tuzlu07x/foreman/releases) for earlier notes.
