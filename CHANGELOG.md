# Changelog

All notable changes to Foreman are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
- **Security**
  - The Claude Code hook now fails closed. Before, any error (a locked DB, bad
    JSON) let the tool run.
  - The hook now applies `policy.yaml` and writes audit rows.
  - Telegram approvals work end to end. Buttons carry the real approval id plus
    an HMAC tag, so the relaying agent cannot approve its own call. Decisions
    are persisted across processes.
  - LLM verdicts can only make Foreman stricter; a prompt-injected "allow" can
    no longer relax a gate.
  - Secrets are redacted from notifications, the verifier prompt, the security
    report and the audit log.
  - Config and state directories are 0700; the DB and policy files are 0600.
  - Blocked or paused agents are denied on every transport.
  - Policy matching:
    - Invalid regexes fail safe.
    - Paths are normalised and matched case-insensitively across all
      path-like arguments.
    - A remembered "always allow" no longer overrides targeted guards.
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
- **Approvals**: approval timeouts are audited as `approval-timeout`.
- **Misc**
  - Agent-side session ids no longer abort approved calls.
  - The delegation watchdog is cleared on shutdown.
  - The CLI uses `parseAsync`.
  - Pushing a SOUL backs up user-authored identity files.

### Changed
- Node **22.12+** is required. Node 20 reached end-of-life on 2026-04-30, and
  `ink` 7 / `commander` 15 need Node 22. The installer now sets up Node 22.
- The default Claude Code hook matcher also covers `Read`, `NotebookEdit`,
  `WebSearch` and third-party `mcp__…` tools.
- The MCP SDK floor is raised to 1.30 (lockfile unchanged).

## [0.1.6] - 2026-06-01

Last published release. See the
[GitHub releases](https://github.com/tuzlu07x/foreman/releases) for earlier notes.
