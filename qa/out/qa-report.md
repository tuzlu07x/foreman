# Foreman QA report

- Generated: 2026-09-27T15:35:47.643Z
- Foreman: v0.1.6 (98ad9db)
- Node v22.22.2 on linux/x64
- Result: **7 passed, 0 failed, 0 skipped** in 1m 55s
- Every scenario ran the built CLI (`dist/cli/index.js`) as real processes, in its own temporary
  FOREMAN_HOME, HOME and working directory, with stub agent CLIs first on PATH and a guard that refuses
  any network connection other than 127.0.0.1.

| # | Scenario | Result | Duration | Steps |
| --- | --- | --- | --- | --- |
| 1 | First run: init, doctor, inbox | PASS | 6.2 s | 6/6 |
| 2 | MCP agent through mcp-stdio and the hub: allow, ask/timeout, poisoning, rug pull | PASS | 13.2 s | 10/10 |
| 3 | Approve and deny from the TUI across processes | PASS | 11.9 s | 5/5 |
| 4 | TUI command console: status, write, approve | PASS | 11.3 s | 4/4 |
| 5 | Org: chart, delegation, department channels and per-department MCP servers | PASS | 30.3 s | 7/7 |
| 6 | Notifications: signed webhook for a critical approval, outcome in the inbox | PASS | 19.2 s | 4/4 |
| 7 | Spend and budgets: OTLP usage, reports, a paused department | PASS | 22.3 s | 9/9 |

## 1. First run: init, doctor, inbox: PASS (6.2 s)

File: `qa/scenarios/01-first-run.qa.ts`

A new user installs Foreman and runs `foreman init`, `foreman doctor` and `foreman inbox` on an empty home.

- PASS `foreman init` creates identity, policy, soul and audit database (0.9 s)
  - files: identity.key (mode 600), policy.yaml (600), SOUL.md, foreman.db (600)
  - init output: identity ed25519:e582184d (new)
- PASS the audit database starts empty and fully migrated (0.8 s)
  - 27 tables incl. requests, audit_events, pending_approvals, inbox_items; requests rows: 0
  - `foreman log tail --json` → []
- PASS `foreman doctor --json` reports no failures (1.0 s)
  - summary: 25 ok, 2 warn, 0 fail (exit 1)
  - warnings: agents_registered, chafa
  - ok: expected_files, identity_key, database, migrations, fts5, policy_yaml
- PASS `foreman inbox` works on an empty inbox (2.6 s)
  - `foreman inbox` → "Nothing here yet"; `foreman inbox --json` → []; `foreman inbox read` exits 0
- PASS a second `foreman init` keeps the existing identity (0.9 s)
  - identity.key unchanged after re-running init
- PASS nothing tried to reach the network (0.0 s)
  - network guard: 0 non-loopback connection attempts

## 2. MCP agent through mcp-stdio and the hub: allow, ask/timeout, poisoning, rug pull: PASS (13.2 s)

File: `qa/scenarios/02-mcp-hub.qa.ts`

An MCP agent (`claude-code`) talks to `foreman mcp-stdio`, which proxies two upstream MCP servers from mcp.yaml (the real demo server from tests/core/mcp-hub/fixtures). Every decision is checked in the audit DB.

- PASS tools/list has Foreman tools plus the hub tools, minus denied and poisoned ones (0.2 s)
  - 17 tools; hub: demo__echo, demo__read_config, demo__big_report, sketchy__echo, sketchy__read_config, sketchy__big_report, sketchy__delete_everything
  - hidden: demo__delete_everything (tools.deny), sketchy__add (poisoned description)
- PASS an allowed hub call returns upstream data and is audited as allowed (0.1 s)
  - reply: "hello from qa"
  - requests 01M3HR1M7MDH2BGH6TG8BDR8SF: demo__echo allowed, decided_by=policy:mcp.yaml:demo
  - audit_events mcp:call: server=demo tool=echo isError=false
- PASS results are guarded: secrets redacted and injected instructions flagged (0.1 s)
  - token in the upstream result is not in the reply; mcp:call redactions=1, injectionFlags=["injection_system_override"]
  - reply starts: "⚠ Foreman: this tool result contains text that looks like instructions to an AI agent. Tre"
- PASS a hub tool with no rule asks; nobody answers, so it is denied on timeout and audited (2.1 s)
  - reply: error: Denied by approval-timeout (FOREMAN_APPROVAL_TIMEOUT=2)
  - requests 01M3HR1MF4JXE9185KM59B87XJ: denied, decided_by=approval-timeout; pending_approvals: resolved/denied by timeout
- PASS the poisoned tool is quarantined: hidden from the listing and refused when called (0.9 s)
  - reply: "Foreman withheld 'sketchy__add': suspicious definition: contains an <IMPORTANT>/<SYSTEM>-style instruction block; asks the agent to hide something from the user…"
  - `foreman mcp tools sketchy --json`: add is quarantined (4 findings); never reached the mediator (0 requests rows)
- PASS a tool that is not on the hub goes through policy + risk: read_file of .env asks and times out (2.1 s)
  - requests 01M3HR1QCK3753Z1NK05FX1VFB: read_file config/.env → denied by approval-timeout, risk bucket high (secret_path)
- PASS the agent disconnects cleanly (0.0 s)
  - mcp-stdio exited 0 after stdin closed
- PASS rug pull: the server changes a pinned tool; the next session detects and blocks it (3.4 s)
  - first tools/list of the session (pinned cache) still lists demo__echo: true
  - call reply: "Upstream MCP server 'demo' failed: Foreman withheld 'demo__echo': definition changed since it was pinned (possible rug pull). Review it with `foreman …"
  - second tools/list: demo__echo withheld
  - audit_events mcp:call: tool=echo isError=true error="…possible rug pull…"; requests 01M3HR1TETW4T0ATKWQRFRM4E0: decision=allowed decided_by=policy:mcp.yaml:demo
  - `foreman mcp tools demo --refresh --json`: echo quarantined, "definition changed since it was pinned"
- PASS `foreman mcp trust demo` accepts the new definition and the tool works again (2.5 s)
  - trust output: "✓ pinned 4 tool definitions for demo"; demo__echo listed and returns "trusted again"
- PASS nothing tried to reach the network (0.0 s)
  - network guard: 0 non-loopback connection attempts

Notes:

- The rug-pull call is audited in `requests` (what `foreman log tail` shows) as "allowed by policy:mcp.yaml:demo", although the hub withheld it; the block is only visible in the mcp:call audit event.
- Without --refresh, `foreman mcp tools demo` (the command the withheld message tells the user to run) reads the pinned cache and shows echo as available, so the rug pull is not visible there.

## 3. Approve and deny from the TUI across processes: PASS (11.9 s)

File: `qa/scenarios/03-tui-approvals.qa.ts`

`foreman start` runs in a real pseudo-terminal. A separate agent process (`foreman mcp-stdio --source claude-code`) makes risky calls; the approval shows up in the TUI and is decided with the `a` and `d` keys.

- PASS `foreman start` boots the TUI in a pty (4.7 s)
  - foreman start pid 10491 (pidfile written); dashboard header: "0/0 agents", "nothing waiting"
  - the running foreman start has FOREMAN_HOME = the sandbox and the network guard preloaded (/proc/<pid>/environ)
- PASS a risky call (read_file config/.env) waits for approval; `a` allows it (2.2 s)
  - TUI shows the approval: claude-code → read_file(config/.env); pending_approvals 01M3HR3E6JGPJKSZSV5A4EXG9J is pending (risk high)
  - agent reply: "(foreman) read_file allowed by user"
  - requests 01M3HR3E6JGPJKSZSV5A4EXG9J: allowed, decided_by=user; pending_approvals: resolved_by=user
  - foreman inbox --json: "Allowed read_file for claude-code" / "by you in the TUI"
- PASS a second risky call (read_file backup/.ssh/id_rsa); `d` denies it (3.1 s)
  - TUI shows the approval: claude-code → read_file(backup/.ssh/id_rsa); pending_approvals 01M3HR3GB6FHEK3A1K5EB22RH4 is pending (risk high)
  - agent reply: error "Denied by user"
  - requests 01M3HR3GB6FHEK3A1K5EB22RH4: denied, decided_by=user; pending_approvals: resolved_by=user
  - foreman inbox --json: "Denied read_file for claude-code" / "by you in the TUI"
  - foreman log tail --json lists both decisions (allowed, denied) with decidedBy=user
- PASS the agent disconnects and `foreman start` shuts down cleanly (0.1 s)
  - SIGTERM → foreman start exited 0, pidfile removed, pid 10491 gone
- PASS nothing tried to reach the network (0.0 s)
  - network guard: 0 non-loopback connection attempts

Notes:

- Across processes the requests row (and `foreman log tail`) records decided_by "user", not "user:tui"; the TUI as the deciding surface only shows in the inbox ("by you in the TUI").

## 4. TUI command console: status, write, approve: PASS (11.3 s)

File: `qa/scenarios/04-tui-console.qa.ts`

The `:` console in `foreman start` (real pty): `status`, `write codex add tests` (the stub codex runs and its output lands in the inbox), and `approve` for an approval on screen.

- PASS `:` then `status` lists the registered agents (0.3 s)
  - console: "Foreman v… — 2 agents registered", lists codex and claude-code
  - audit_events foreman:command: status, sourceAgent=tui, ok=true
- PASS `write codex add tests` runs the (stub) codex and its output lands in `foreman inbox` (1.1 s)
  - console: "Spawning codex with your task — output will arrive in the Activity feed and your inbox…"
  - foreman inbox --json: "codex finished: add tests" / "[qa-stub codex] received: exec add tests [qa-stub codex] done, nothing was changed"
  - control_commands #1: write ["codex","add tests"] from tui → applied
  - audit_events control_write_outcome: codex exec → spawnKind=ok exitCode=0; foreman:command write ok
- PASS `approve` in the console decides the approval on screen (2.5 s)
  - approval on screen: claude-code → read_file(service/.env.production), request 01M3HR3X2HK9VC2MW0C4Q9CMXE
  - console: "Allowed read_file for claude-code."
  - agent reply: "(foreman) read_file allowed by user"; requests: allowed, decided_by=user; inbox: "Allowed read_file for claude-code" / "by you in the TUI"
- PASS `foreman start` shuts down cleanly and nothing reached the network (0.1 s)
  - foreman start exited 0; network guard: 0 non-loopback connection attempts

## 5. Org: chart, delegation, department channels and per-department MCP servers: PASS (30.3 s)

File: `qa/scenarios/05-org.qa.ts`

A startup org chart run by agents: grow it from the CLI, then check that delegation (`submit_command write`), department channels (`org_post`) and the MCP hub all follow the chart.

- PASS `foreman org init --template startup` writes a valid chart (2.7 s)
  - org init: "✓ wrote /tmp/foreman-qa-org-buf5kH/foreman/org.yaml (startup)"; org validate exits 0
  - org show: ceo (hermes), cto (claude-code), engineer (codex), cmo (openclaw), cfo (zeroclaw), support-lead
- PASS grow it: `org add-department sales`, `org add-role sdr` and `org add-role qa` (3.8 s)
  - sales (head cso = sales-agent), sdr → cso, qa → cto; org validate exits 0; org.yaml comments kept
- PASS `foreman org check` explains delegation decisions (1.9 s)
  - claude-code → codex: "allowed — cto manages engineer"
  - codex → openclaw: "blocked — engineer → cmo is outside the reporting chain in org.yaml (cross-department work goes through department heads)" (exit 1)
- PASS delegation along the chart is queued; across departments it is blocked (ORG_POLICY) (3.8 s)
  - cto (claude-code) → engineer (codex): "Spawning codex with your task — output will arrive in this c…"; control_commands #1 pending
  - cso (sales-agent, the new Sales head) → cto (claude-code): queued (heads coordinate directly)
  - engineer (codex) → cmo (openclaw): "Blocked by the org chart: engineer → cmo is outside the reporting chain in org.yaml (cross-department work goes through department heads). Hand the ta…"
  - sdr (sdr-agent) → qa (qa-agent): blocked by the org chart
  - audit_events foreman:command: 2 × ok=false errorCode=ORG_POLICY (codex, sdr-agent); control_commands holds only the 2 allowed directives
- PASS `org_post` follows the chart; `foreman org messages` shows what was said (6.6 s)
  - codex → #engineering: "Posted to #engineering (id 01M3HR18XRFY7844VRBJGAHR0X)."
  - codex → #marketing: "Not sent: write to your department head, who can take it to marketing."
  - claude-code (head) → #marketing: posted; sdr-agent → #leadership: refused; codex org_report → "Posted to cto ↔ engineer (id 01M3HR1CPP5V4P929EQZAX9KF5)."
  - foreman org messages: 3 messages, e.g. "just now · #engineering · engineer (codex): parser tests are green"
  - foreman org messages engineering: only the #engineering message
  - audit_events org:message: 3 ok, 2 refused (codex, sdr-agent); org_messages channels: dept:engineering, dept:marketing, dm:cto|engineer
- PASS each department sees only its own MCP hub servers (3.9 s)
  - mcp.yaml: servers demo and brand-kit; org.yaml: engineering → [demo], marketing → [brand-kit]
  - codex (engineering) sees: demo__echo, demo__read_config, demo__big_report, demo__delete_everything
  - openclaw (marketing) sees: brand-kit__echo, brand-kit__read_config, brand-kit__big_report, brand-kit__delete_everything
  - codex calling brand-kit__echo: "Your role in org.yaml does not include the 'brand-kit' MCP server. Ask your manager or the user."
- PASS nothing tried to reach the network (0.0 s)
  - network guard: 0 non-loopback connection attempts

## 6. Notifications: signed webhook for a critical approval, outcome in the inbox: PASS (19.2 s)

File: `qa/scenarios/06-notifications.qa.ts`

A `webhook` channel pointing at a local receiver on 127.0.0.1, signed with a secret and routed for `critical`. While `foreman start` runs, a risky agent call must reach the receiver as a signed approval notification, and the TUI inbox must record the approval and how it ended.

- PASS configure the webhook: URL and signing secret in the secret store, routed for critical (4.8 s)
  - receiver http://127.0.0.1:39589/foreman/hook; secrets webhook-url + webhook-secret stored encrypted (neither value appears in notify.yaml)
  - `foreman notify enable webhook`, `foreman notify route critical webhook`; `foreman notify status` lists webhook
- PASS `foreman notify test webhook` delivers a signed test message (1.0 s)
  - POST /foreman/hook: "Foreman test ✓", X-Foreman-Signature valid (and invalid under a wrong secret), user-agent foreman/0.1.6
  - a plain http:// URL is accepted: WebhookChannel does not restrict the URL scheme
- PASS a risky call while `foreman start` runs sends a signed approval notification (7.9 s)
  - pending_approvals 01M3HR30WFNBHJ4T5SMDP80K10 (risk high) → webhook POST, signature valid
  - payload: level=critical, agentBlocking=true, title="[HIGH] claude-code · read_file", actions=[allow, deny, inspect, block_secret_path]
  - agent reply after its 5 s deadline: "Denied by approval-timeout"
  - follow-up POST "Foreman update" (signed) ends: "✗ Denied (timeout default) at 15:35:16"
  - ids: approval payload id=01M3HR30ZPT1MBXKXZY5NMQHGB requestId=01M3HR30WFNBHJ4T5SMDP80K10; follow-up id=webhook-1 requestId=null
  - notifications row 01M3HR30ZPT1MBXKXZY5NMQHGB: level=critical channel=webhook status=sent
  - foreman inbox --json: "Approval needed: claude-code → read_file" (warning, risk 60 (high) · secret_path) and "Denied read_file for claude-code" / "nobody answered in time"
  - requests: denied, decided_by=approval-timeout
- PASS every delivery was signed, and nothing but the local receiver was contacted (0.1 s)
  - 3 webhook deliveries, all with a valid X-Foreman-Signature; network guard: 0 non-loopback connection attempts

Notes:

- The webhook follow-up that reports the outcome (title "Foreman update", level info) carries id "webhook-1" and requestId null, so a receiver cannot match it to the approval notification (id 01M3HR30ZPT1MBXKXZY5NMQHGB, requestId 01M3HR30WFNBHJ4T5SMDP80K10) except by parsing the body text.

## 7. Spend and budgets: OTLP usage, reports, a paused department: PASS (22.3 s)

File: `qa/scenarios/07-spend-budgets.qa.ts`

Engineering gets a $1/month budget with `--pause`. While `foreman start` runs, Claude Code telemetry (OTLP JSON) reports a $2.50 request; spend shows up in `foreman usage` and `foreman org report`, agents can no longer hand Engineering work, and the inbox gets a budget alert.

- PASS `foreman org budget engineering 1 --pause` sets a pausing budget (0.8 s)
  - org.yaml: engineering.budget { monthly_usd: 1, on_exceed: pause }
- PASS the spend receiver listens on 127.0.0.1:$FOREMAN_OTLP_PORT and rejects requests without the key (0.0 s)
  - FOREMAN_OTLP_PORT=35185; POST /v1/logs without x-foreman-usage-key → 401 {"error":"missing or wrong usage key"}
  - wrong key → 401; agent_usage still empty
- PASS before the spend, the CEO can hand Engineering work (the stub codex runs) (3.1 s)
  - hermes (ceo) → codex: "Spawning codex with your task — output will arrive in this c…"; inbox: "codex finished: refactor the billing module" / "[qa-stub codex] received: exec refactor the billing module [qa-stub codex] done, nothing was changed"
- PASS Claude Code telemetry with the usage key is recorded against Engineering (0.0 s)
  - POST with key → 200; agent_usage: claude-code (cto, engineering), telemetry, claude-sonnet-4-5, 12000 in / 3400 out, $2.5 (reported, not estimated)
- PASS `foreman usage` and `foreman org report engineering today` show the spend (2.8 s)
  - foreman usage: "Agent spend · today · $2.50 | engineering $2.50 65.4k tokens"
  - foreman usage month --by agent --json: [{ key: claude-code, costUsd: 2.5 }]
  - foreman org report engineering today: "Engineering · today", "Spend $2.50", "Budget engineering (month): $2.50 of $1.00 (250%) — over, paused"
- PASS with the budget spent, an agent can no longer hand Engineering work (1.0 s)
  - hermes → codex: "Paused by budget: Engineering is over its monthly budget ($2.50 of $1.00). Ask the user to raise it (foreman org budget)…"
  - audit_events foreman:command: write from hermes ok=false errorCode=ORG_POLICY; control_commands still holds only the first directive
- PASS the owner can still assign work to the paused department from the TUI (2.4 s)
  - TUI console "write codex ship the hotfix" → spawned; inbox: "codex finished: ship the hotfix"
- PASS the budget alert lands in the inbox (the watcher checks at start, then every minute) (1.9 s)
  - restarted foreman start; inbox: [critical] "Engineering is over its monthly budget" / "$2.50 of $1.00 (this month) · agents can't hand it new work until the period resets · change it: foreman org budget engineering <usd>"
- PASS nothing tried to reach the network (0.0 s)
  - network guard: 0 non-loopback connection attempts

