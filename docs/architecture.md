# Foreman v0.1.0 — Architecture report

A single-document tour of how Foreman is built. Skim the headlines for the shape; dive into a section when you're about to touch that area.

---

## 1. One-paragraph pitch

Foreman is a **local guardian** that sits between the AI agents the user has installed (Hermes, Claude Code, Codex, OpenClaw, custom MCP servers…) and the rest of the system. Every tool call the agent wants to make is intercepted, evaluated against the user's policy, optionally surfaced as an approval modal in the TUI, and recorded in a tamper-evident audit log. Foreman never replaces the partner runtime; it stands behind it.

---

## 2. Repo layout (top-level)

```
foreman/
├── src/
│   ├── cli/              CLI commands (init, setup, start, secrets, …)
│   ├── core/             services + business logic
│   ├── db/               Drizzle schema + migrations
│   ├── identity/         Ed25519 keypair + secret-store master key
│   ├── tui/              Ink-based dashboard (App, pages, components)
│   └── utils/            paths, migrations helpers
├── registry/agents.json  the curated AgentEntry catalogue
├── tests/                vitest suites (561 at v0.1.0)
├── install.sh            curl-pipe install script (npm-based)
└── docs/                 this report + install + completion + WSL2 notes
```

---

## 3. CLI surface

Every subcommand lives in its own file under `src/cli/`. The root `src/cli/index.ts` wires them into commander:

| Command | What it does |
| --- | --- |
| `foreman init` | Seeds the Foreman home: `identity.key` (Ed25519), `policy.yaml` (smart-default rules), `SOUL.md` (Foreman identity persona), `foreman.db` (SQLite). Idempotent. |
| `foreman setup` | Interactive Ink wizard — API keys → agents → install → policy review. Re-runnable with `--resume` / `--reset`. |
| `foreman start` | Detects fresh installs and runs the wizard inline, then mounts the gateway + TUI dashboard. `--no-onboarding` skips the wizard. |
| `foreman mcp-stdio --source <agent>` | Acts as an MCP server over stdio for the partner runtime. JSON-RPC `tools/list` + `tools/call` go through the mediator. |
| `foreman wrap --name <id> -- <cmd>` | Spawns a child process under Foreman; intercepts its MCP-framed stdout, signs responses, audits every call. |
| `foreman log tail / search / show` | Reads the audit log. FTS5-indexed; `search` queries the index, `tail` paginates, `show <id>` expands one row. |
| `foreman policy show / edit / reset` | Inspects + edits `policy.yaml`. `edit` opens `$EDITOR`, then reloads + reports the rule count. |
| `foreman agent add / list / remove / show / regenerate-key / block / unblock / update` | Manages registered agents. Aliased as `agents`. |
| `foreman secrets add / list / show / rotate / remove` | Manages the encrypted secret store (AES-256-GCM at rest). `show` refuses without `--yes-i-want-to-see-it`. |
| `foreman registry list / info / update / validate` | Curated catalogue lookup. `update` refreshes from the upstream URL (24 h TTL). |
| `foreman identity show / edit / reset / push` | Foreman's canonical SOUL.md propagated into each partner runtime's identity hook (`~/.hermes/SOUL.md`, etc.). |
| `foreman doctor` | 14 checks across paths, identity, db, fts5, policy, agents, mcp gateway, legacy home, updates, chafa. Exit codes 0 / 1 / 2. |
| `foreman migrate-config` | Migrates a legacy `~/.foreman/` install into the platform-native XDG / macOS / Windows dirs. |
| `foreman migrate --check / --apply` | DB schema migration runner. |
| `foreman completion bash / zsh / fish` | Prints a shell-completion script. |

Each command:
1. Verifies the foreman home exists (or prompts to run `init`).
2. Constructs the services it needs locally.
3. Calls `closeDb()` on the way out so the next invocation gets a fresh handle.
4. Accepts `--json` for piping where it makes sense.

---

## 4. Core services (`src/core/`)

### RegistryService — `registry.ts`
Owns the `agents` table. `register` issues a fresh Ed25519 keypair per agent; the private key is returned **once** to the caller and never persisted. `list()` filters out blocked rows; `listAll()` exposes them for the Agents page. `block / unblock / remove / regenerateKey` give the TUI agents page everything it needs.

### PolicyEngine — `policy-engine.ts`
Loads `policy.yaml` into the `policies` table inside one transaction (PR #128 closed a race where readers saw the empty-policy window). `evaluate(req)` walks rules by specificity: conditional `tool:read_file` ASK rules win over blanket `*` ALLOW rules. `evaluateSecretAccess` is deny-by-default — only an explicit allow rule grants access.

### MediatorService — `mediator.ts`
The chokepoint. Every tool call (`foreman mcp-stdio`, `foreman wrap`, in-TUI Chat console) calls `handleRequest`:
1. Authenticate the signed payload (no-op when the caller skips signing).
2. Refuse if the session was halted.
3. Risk-score the call.
4. Evaluate policy → ALLOW / ASK / DENY.
5. On ASK, ask the approval service (DB-backed bridge for cross-process flows, see §6).
6. Optionally forward to a target agent through the gateway.
7. Persist the request + decision to `requests` (FTS5-indexed).

### ApprovalService — `approval.ts`
Three implementations:
- `BusApprovalService` — emits `approval:requested` on the in-memory bus, awaits `approval:resolved`. Same-process only.
- `ReadlineApprovalService` — interactive prompt at the terminal. Used when there's no TUI.
- `DbApprovalService` — writes a pending row to `pending_approvals`, polls for resolution. Cross-process safe (PR #118).

The TUI process runs an `ApprovalBridge` that polls `pending_approvals` and emits the matching bus event so the modal pops. After the user decides, the bridge writes the decision back to the row; the requester's poll sees it and proceeds.

### SecretStore — `secret-store.ts`
AES-256-GCM at rest. Master key lives at `<foreman_home>/secrets.key` (mode 0600). `add` refuses to overwrite (`rotate` is the explicit replace). `get` updates `lastAccessedAt`. `list()` returns metadata only — never the plaintext.

### AuditLogger — `audit.ts`
Writes finalized requests into the `requests` table inside `db.transaction((tx) => …)`. The `requests_fts5` virtual table + sync triggers (hand-written SQL migration, not Drizzle) keep search indexed.

### SessionManager — `session.ts`
Tracks agent-to-agent conversations. Halts a session at a turn cap or a token budget, so two agents can't ping-pong forever.

### RiskScorer — `risk-scorer.ts`
Cheap per-request heuristic: secret-shaped paths, destructive shell verbs, exfil patterns. The TUI surfaces the score + reasons in the inspect view.

### Foreman SOUL propagation — `foreman-soul.ts`
Reads `<foreman_home>/SOUL.md` (Foreman's canonical persona) and writes it into the partner runtime's identity hook on `foreman agent add`. The Foreman identity (PR #133) hardens against the partner runtime leaking its product / model / OS info (PR #142).

---

## 5. Data layer (`src/db/`)

SQLite via `better-sqlite3` + Drizzle.

| Table | Purpose |
| --- | --- |
| `agents` | id, displayName, status (active / inactive / blocked), publicKey, metadata, registeredAt, lastSeenAt |
| `policies` | sourceAgent, target, effect (allow / deny / ask), conditions (JSON), createdBy, enabled, createdAt |
| `requests` | id (ULID), sourceAgent, targetAgent, targetTool, args (JSON), riskScore, riskReasons (JSON), decision, decidedBy, result, durationMs, createdAt, decidedAt |
| `requests_fts` | FTS5 virtual table mirroring `requests` (hand-written migration `0001_fts5_requests.sql`) |
| `secrets` | name, ciphertext, iv, tag, createdAt, lastAccessedAt |
| `sessions` | id, participants (JSON array), startedAt, endedAt, status, messageCount, tokenCount |
| `pending_approvals` | requestId, sourceAgent, targetAgent, targetTool, args, riskScore, riskReasons, status, decision, remember, resolvedBy, requestedAt, resolvedAt (PR #118) |
| `__drizzle_migrations` | Drizzle's own bookkeeping |

Migrations are hand-written SQL files under `src/db/migrations/`, plus a `_journal.json` Drizzle uses to track applied ones. `tsup` copies them into `dist/db/migrations` so the published package can apply them on install.

---

## 6. MCP integration (`src/cli/mcp-stdio.ts`, `src/core/mcp-gateway.ts`)

Foreman exposes itself as an **MCP server** over stdio so the partner runtime can call it. The server advertises **one explicit tool** (`secrets/get`) plus the implicit "send anything else and Foreman will mediate it" surface.

When the partner runtime calls `tools/call` with `name = read_file`, `arguments = { path: ".env" }`:
1. mcp-stdio calls `mediator.handleRequest({ sourceAgent: "<--source flag>", targetTool: "read_file", message: <jsonrpc> })`.
2. Mediator evaluates policy — `.env` paths hit the ASK rule.
3. Mediator pushes a pending row → `ApprovalBridge` in `foreman start` sees it → modal pops.
4. User decides — mediator returns to mcp-stdio.
5. mcp-stdio replies to the partner with `result.content` (allowed) or `error.code = -32603` (denied).

The partner runtime sees a normal MCP server. The audit log + policy are invisible from its perspective.

---

## 7. TUI (`src/tui/`)

Ink-based, single-window dashboard with sub-pages. Built on `@inkjs/ui` for inputs.

### Shell architecture
`App.tsx` mounts `DashboardProvider` (a React context carrying all services) around `Shell`. `Shell` owns:
- the current `page` (one of `dashboard / logs / policy / sessions / agents / secrets / settings / chat`)
- a slot per page for `selectedIdx`, `expanded`, `notice` and any modal state
- the keyboard handler (`KeyboardHandler`) that fans key presses out by page

Each page module under `src/tui/pages/` is a stateless component that reads from `useDashboardServices()` + a 2 s heartbeat to refresh.

### Dashboard panels
Three panels, responsive layout via `useLayout()`:
- **Agents** — live status dots (active / blocked) + request count per agent.
- **Activity** — last N requests with 200 ms fade-in on new rows, spinner on in-flight.
- **Today** — bar gauges: allowed / denied / pending percentages, active session count.

### Pages

| Page | Hotkey | What it does |
| --- | --- | --- |
| `dashboard` | (default) | the 3-panel overview |
| `agents` | `a` | list registered agents incl. blocked, per-row block/unblock/regen-key/remove (PR #143) |
| `chat` | `c` | pick source agent → type tool name + JSON args → mediator returns decision (PR #146) |
| `settings` | `g` | edit Foreman SOUL.md, edit policy.yaml, surface re-run-wizard command (PR #145) |
| `secrets` | `k` | list stored secrets, reveal value 10 s, rotate inline, remove (PR #144) |
| `logs` | `l` | audit log with FTS5 search, filters (allowed/denied/ask/errored), replay, export |
| `policy` | `p` | view rules, `e` opens `$EDITOR` then reloads, `d` toggles enabled |
| `sessions` | `s` | active + completed sessions, expand for full transcript, `k` halts active |
| help | `?` | overlay listing every hotkey grouped by page |
| quit | `q` / Ctrl-C | confirm modal then exit |

### Approval modal
Pops on any `approval:requested` event. Shows agent → target flow, indented tool call, ◆ risk reasons, 60 s countdown that colour-shifts at ≤30 s / ≤10 s. Hotkeys: `a` allow once / `A` always allow / `d` deny / `D` always deny / `r` remember rule / `i` inspect (request chain + full JSON).

### Modal pattern
Pages with sub-input modes (Secrets page rotate, Chat page input) use the same shape: a boolean flag (`rotateMode`, `chatInputMode`). The page-level keyboard handler short-circuits to Esc-only when the flag is true; the `PasswordInput` / `TextInput` from `@inkjs/ui` owns the rest.

### Setup wizard
The same Ink tree used both by `foreman setup` and `foreman start` (when `looksLikeFreshInstall()` returns true). Four steps:
1. **API keys** — MultiSelect with the five common secrets pre-checked (PR #148) + help URL per secret in the value prompt (PR #135).
2. **Agents** — MultiSelect with `hermes` + `claude-code` pre-checked on fresh install; `Pre-checked: …` label in accent colour above the picker (PR #142).
3. **Install** — Prints a `Selected agents: … / Will install: …` summary, then runs `runInstallStep` to install / register / inject MCP snippet / write Foreman identity per agent.
4. **Policy** — Optional `$EDITOR` review of `policy.yaml`.

`runInstallStep` is exported and unit-tested (6 cases).

---

## 8. Identity layer

Hermes documents `~/.hermes/SOUL.md` as "the agent's primary identity — completely replaces the default." Foreman pushes its canonical identity through that hook so the partner runtime greets the user as **Foreman** rather than the underlying product.

The flow (PR #133 + #142):
1. `foreman init` seeds `<foreman_home>/SOUL.md` with the hardened default — explicit "you are Foreman", banned-word list (Hermes / Claude / OpenAI / Anthropic / gpt-* / claude-*), refuses runtime-introspection commands (`uname`, `hermes …`, `find /usr/local/lib/<partner>*`).
2. Registry entries declare an `identity_path` (currently `~/.hermes/SOUL.md`; other partners pending the right hook).
3. `foreman agent add hermes` writes the SOUL into `~/.hermes/SOUL.md`. The Hermes prompt builder (`agent/prompt_builder.py` → `load_soul_md()`) treats it as identity slot #1, replacing `DEFAULT_AGENT_IDENTITY`.
4. `foreman identity push` re-propagates after every edit.

Open caveat: SOUL.md is loaded as a *context file* by Hermes today, which the LLM weights below the base system prompt. Bot reliably identifies as Foreman when the session is fresh + the SOUL is read, but can leak partner-runtime details when explicitly asked about model / host / processes — issue #141 tracks the hardening that's already in the default SOUL but still depends on the partner runtime honouring it.

---

## 9. Cross-process flow end-to-end

```
[partner runtime]                       [foreman start]
  ↓ JSON-RPC tools/call
foreman mcp-stdio --source X
  ↓ mediator.handleRequest()
PolicyEngine.evaluate()
  ↓ effect = "ask"
DbApprovalService.request()
  ↓ INSERT pending_approvals
                                        ApprovalBridge polls every 200 ms
                                          ↓ sees pending row
                                        bus.emit("approval:requested")
                                          ↓
                                        TUI modal pops
                                          ↓ user presses [a]
                                        bus.emit("approval:resolved")
                                          ↓
                                        ApprovalBridge UPDATE pending_approvals
DbApprovalService poll sees status=resolved
  ↓ returns {decision: "allowed"}
mediator.finalize() → INSERT requests
  ↓ JSON-RPC response
[partner runtime] receives result
```

Default poll interval 200 ms, configurable per service. Stale rows older than 5 min auto-deny.

---

## 10. Test layout (561 tests at v0.1.0)

- `tests/core/` — pure-logic helpers, services with `createInMemoryDb()`.
- `tests/cli/` — command-output snapshots, error paths, exit codes.
- `tests/tui/` — content builders + setup-wizard diff-loop logic. Ink rendering itself is **not** unit-tested for v0.1; manual smoke through the catalogue is the integration check.
- `tests/db/` — schema migrations + FTS5 + transaction safety.

Build pipeline (`tsup`): one ESM bundle at `dist/cli/index.js`; migrations copied alongside; node20 target.

---

## 11. Where to start when changing something

| Want to change… | Touch… |
| --- | --- |
| A CLI command's UX | `src/cli/<name>.ts` + the matching unit test |
| The mediator's decision logic | `src/core/mediator.ts` + `src/core/policy-engine.ts` |
| The TUI dashboard | `src/tui/app.tsx` (Shell + keyboard handler) and the relevant `src/tui/pages/<name>-page.tsx` |
| The setup wizard | `src/tui/setup-wizard.tsx` (steps + MultiSelect / PasswordInput) |
| The audit log schema | `src/db/schema.ts` + a new migration in `src/db/migrations/` |
| The Foreman identity / SOUL | `src/cli/identity-template.ts` (default content) + `src/core/foreman-soul.ts` (propagation) |
| The registry catalogue | `registry/agents.json` + `src/core/registry-catalog.ts` (Zod schema) |
| The cross-process approval bridge | `src/core/approval.ts` (DbApprovalService + ApprovalBridge) |

See also: `feedback_manual_qa_catalog.md` in the user's auto-memory for the full ~75-scenario manual QA matrix.
