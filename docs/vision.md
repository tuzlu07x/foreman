# Foreman — Product Vision

**Date:** 2026-05-17
**Author:** Fatih Tuzlu (with refinements via QA round 2 design discussion)
**Status:** Active — directly drives the v0.1.0 / v0.2 / v0.3 milestones.

This is the long-form product narrative. The concrete work items are tracked as GitHub issues under the matching milestones — see "Issue index" at the bottom.

---

## What Foreman is

Foreman is the guardian and orchestrator your local AI agents talk through.

You give your agents responsibilities — "Hermes writes code", "OpenClaw does project management", "Claude Code reviews PRs". You give Foreman the API keys, the policy, and the channels you want to hear from (Telegram, Discord, Slack). Foreman then:

- **Organises** — routes agent-to-agent calls, enforces who can delegate what to whom
- **Supervises** — scores every tool call for risk, blocks the obvious threats, asks you about the borderline ones
- **Intervenes** — pauses an agent that's about to cross a line, tells you what happened in your own words, waits for your call
- **Reports** — daily / weekly summaries with LLM-written narrative, pattern detection, cost notes, suggestions

Three verbs: **organises, supervises, intervenes.**

---

## Who it's for

Solo developers and small teams running multiple AI agents on their own machine — Hermes on Telegram, OpenClaw in the terminal, Claude Code in their editor, maybe Codex or a custom MCP agent. They want the productivity of agents-everywhere without the panic of "did one of them just leak my .env file."

---

## The core mental model — responsibilities

Every agent declares a responsibility note when you register it:

```
Hermes:    "code writing, implementation"
OpenClaw:  "project management, planning, task breakdown"
Codex:     "ad-hoc shell + git operations"
```

That note becomes load-bearing:

1. **Policy** — `responsibility_policies` in `policy.yaml` says "code writers can't touch `~/.ssh/`, project managers can talk to GitHub but not read `.env`".
2. **Delegation** — when OpenClaw asks Hermes to write code, Foreman checks the responsibilities are compatible.
3. **Anomaly** — if Hermes starts opening Jira tickets, Foreman flags it (out of declared role).
4. **Narrative** — every alert / summary refers to the agent by what it does, not just its ID.

This is what makes Foreman different from a generic MCP proxy. The graph of who-does-what is first-class, not metadata.

---

## The user journey

### Onboarding (today: broken; v0.1.0: fixed)

`foreman setup` walks you through 5 steps in one pass:

1. **welcome** — context, what we're about to do
2. **providers** — paste the LLM keys you have (Anthropic, OpenAI, Gemini, Ollama). Foreman writes them to the encrypted secret store + `llm.yaml`.
3. **agents** — pick agents from the curated registry. For each multi-provider agent, **only the LLMs you configured in step 2 are selectable**. Single-provider agents whose required LLM is missing surface a clear "add key now / pick different agent / skip" dialog. No silent breaks.
4. **services** — Telegram bot + chat ID, Discord webhook, Slack channel. Foreman writes them + auto-enables them in `notify.yaml`.
5. **voice** — which proactive notifications do you want from Foreman itself? Daily summary, pattern alerts, agent health, budget warnings. Quiet hours window.

After step 5: `foreman doctor` is fully green. Demo works on first try.

### Daily use

You don't talk to Foreman. You talk to your agents — Hermes on Telegram, OpenClaw in your terminal. Foreman is in the background, reading every tool call they emit. Most never need your attention.

When one does:

- **🟢 low-risk** — Foreman logs it and moves on. You see it in tomorrow's summary if at all.
- **🟡 medium** — Foreman logs it and includes it in the daily digest. No interruption.
- **🟠 high** — Foreman alerts you on Telegram with the context. You decide.
- **🔴 critical** — Foreman pauses the agent immediately + pings you. Default action after timeout: deny.

### Foreman's voice (proactive)

Foreman doesn't only answer when asked. It speaks first when it has something useful to say:

**Daily digest** (template fallback if LLM is off, LLM-narrated when on):
> Bu sabah Hermes'e iki phishing email düştü — ikisi de Anthropic key'ini istiyordu. Aynı pattern, farklı sender. Öğleden sonra OpenClaw todo-app projesini önemli ölçüde ilerletti — 7 issue açtı, Hermes'le 3 kod yazma seansı yaptı, sonuç olarak login flow tamamlandı. Tek dikkat çeken konu: bütçe normalden %20 yüksek, sebep OpenClaw'ın bazı taskları aşırı detaylandırması.

**Pattern alert**:
> Son 3 günde Hermes 12 kez "API key paylaş" tarzı email aldı, hepsini reddettin. Bu phishing kampanyası gibi duruyor — bu sender'ları otomatik filtre etmesi için Hermes'e policy ekleyeyim mi? [Yes] [No] [Show me the attempts]

**Agent health**:
> Claude Code 30 dakikadır cevap vermiyor — MCP gateway "connection refused" alıyor. Gelen istekleri queue'da tutuyorum (şu an 3 bekleyen). [Restart] [Show log] [Drain queue]

**Cost note**:
> Bu ay LLM tüketimi $45 — geçen aya göre %180 artış. OpenClaw ortalama 8K input token per call. Cap koymak ister misin? [Set 4K cap] [Just watch]

Every proactive message can be acted on **from the channel itself** — Telegram inline keyboards persist the user's choice back as a real policy update.

### Agent-to-agent orchestration

The killer scenario:

```
[You → OpenClaw Telegram]
  "todo app yaz bana"
        ↓
[OpenClaw]
  • Responsibility: project management
  • Asks you Telegram'dan: "ne tarz olsun?"
  • Sen: "Next.js, SQLite, Drizzle"
  • OpenClaw → GitHub: opens repo, opens 7 issues
        ↓
[Foreman mediates the OpenClaw → Hermes call]
  • Both responsibilities compatible ✓
  • Risk: low ✓
  • Allow
        ↓
[Hermes]
  • Responsibility: code writing
  • Reads task "Initialize Next.js project"
  • Writes code, commits, opens PR
  • Reports back: "PR #1 ready, review please"
        ↓
[Foreman → You Telegram]
  📊 todo-app progress — 1h in
  ✓ Project initialized (Next.js 15, TypeScript)
  ✓ Database schema (SQLite + Drizzle)
  ⠋ Auth flow (Hermes asking: shadcn/ui or custom?)
  [shadcn/ui kullansın] [Custom build et] [Hermes karar versin]
```

This is the v0.3 vision. Building it requires session tracking (#301), responsibility delegation rules (#299/#300), interactive Telegram (#302), and project tracking (#315) — each shipped as its own issue with its own PR.

### Pause + intervene

When something goes sideways:

```
🟠 Foreman Alert

Hermes is trying to read your SSH private key.
Hermes's responsibility is "code writing, implementation."
Reading SSH keys is outside this scope.

Heuristic flagged: secret_file_pattern (+50)
LLM analysis: This action doesn't fit Hermes's role.
SSH keys aren't typically needed for code writing.

Foreman has paused Hermes. What should I do?

[Allow once] [Allow always for this path] [Deny]
[Deny and permanently restrict SSH access for Hermes]
```

Default action after timeout depends on severity bucket in `notify.yaml routing`. Critical = deny. Warning = ask then default-deny.

For silent-intervention cases (the obvious mistakes), Foreman acts without asking and just notifies:

```
🔴 Action Blocked

Hermes was about to write to /etc/passwd while implementing
"add user model" task.

This is almost certainly a path mistake — Hermes meant
src/models/user.ts.

I've blocked the write and notified Hermes of the error.
Should be back on track. No action needed from you.

[Inspect chain] [Override and allow /etc/passwd write]
```

---

## What's deliberately NOT Foreman

- **Foreman is not an AI agent.** You don't chat with Foreman. You chat with your agents. Foreman watches the conversations and tool calls between them.
- **Foreman doesn't host LLMs.** It uses the keys you give it for its own optional smart features. It doesn't proxy your agent's LLM calls — agents talk to their LLMs directly. Foreman intercepts only MCP tool calls.
- **Foreman is not a platform.** No web dashboard, no team accounts, no SaaS (until v0.4+ multi-user mode). Local-first, single-machine.
- **Foreman doesn't replace your agents.** Hermes is still Hermes. OpenClaw is still OpenClaw. Foreman gives them shared rules + a shared audit trail + a single human in the loop.

---

## Architecture summary

```
┌─────────────────────────────────────────────────────────────┐
│                       USER (you)                             │
│        terminal · Telegram · (later: Discord, Slack)         │
└────────────────────────┬────────────────────────────────────┘
                         │
        approvals · alerts · summaries · suggestions
                         │
┌────────────────────────▼────────────────────────────────────┐
│                                                              │
│                       FOREMAN                                │
│                                                              │
│  ┌──────────────┐    ┌─────────────────┐   ┌─────────────┐ │
│  │ Mediator     │ ←→ │ Risk engine     │ ↔ │ Policy     │ │
│  │  (MCP gate)  │    │  (heuristic+LLM) │   │  (incl.    │ │
│  └──────┬───────┘    └────────┬────────┘   │   resp.)   │ │
│         │                     │             └─────────────┘ │
│         │             ┌───────▼──────┐                      │
│         │             │  Approval    │                      │
│         │             │  service     │                      │
│         │             └──────┬───────┘                      │
│         │                    │                              │
│  ┌──────▼───────┐  ┌─────────▼──────┐  ┌─────────────────┐ │
│  │ Audit log    │  │ Notification   │  │ ForemanVoice    │ │
│  │  + sessions  │  │  service       │  │  (proactive)    │ │
│  └──────────────┘  └────┬───────────┘  └─────────────────┘ │
│                         │                                    │
│  ┌──────────────────────▼─────────────────────────────┐    │
│  │ Channels: telegram (interactive) · discord · slack  │    │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Secret store (AES-256-GCM) — keys, tokens, refs     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└────────────────────────┬─────────────────────────────────────┘
                         │
                  MCP (stdio / http)
                         │
┌────────────────────────▼─────────────────────────────────────┐
│  Agents — Hermes, OpenClaw, Claude Code, Codex, custom MCP   │
└──────────────────────────────────────────────────────────────┘
```

---

## Issue index

### v0.1.0 — Launch (Agent-to-Agent Guardian)

The minimum scope that makes the vision above coherent. Onboarding works, multi-provider LLM works, responsibility engine is wired, agent-to-agent flows are tracked, Foreman has a proactive voice, Telegram is interactive.

| # | Title |
| --- | --- |
| #289 | wizard does not write llm.yaml after providers step |
| #290 | wizard does not write notify.yaml / enable channel after services step |
| #291 | wizard creates duplicate / mismatched secret slots |
| #292 | wizard offers OpenAI as a provider but runtime errors |
| #293 | TUI Chat page misleads users (rename to mediator test) |
| #294 | Implement OpenAI provider for LLM verification + smart report |
| #295 | Implement Gemini provider for LLM verification + smart report |
| #296 | LLM provider factory — remove hardcoded "only anthropic" throws |
| #297 | Wizard smart agent-LLM gating |
| #298 | Hermes mcp add hint — incorrect syntax in setup install log |
| #299 | Responsibility-based policy schema in policy.yaml |
| #300 | Responsibility-violation risk rule |
| #301 | Agent-to-agent flow tracking — tag OpenClaw→Hermes delegations |
| #302 | Interactive Telegram inline keyboards — approve/deny from phone |
| #303 | ForemanVoice v1 — proactive notification framework |
| #304 | Pattern detection v1 — repeated-denial / burst / off-role |
| #305 | voice.yaml config + setup wizard step |
| #306 | Smart LLM-powered summary digests |
| #307 | doctor llm.credentials check — verify configured secret resolves |
| #308 | E2E test — fresh wizard → demo approval flow → audit log |

### v0.2 — Health + Suggestions

Post-launch polish + the next bucket of proactive intelligence.

| # | Title |
| --- | --- |
| #309 | Agent health daemon — surface crashed subprocess / MCP timeout |
| #310 | Agent suggestion engine — recommend new agents based on task gaps |
| #311 | Advanced pattern detection — multi-event correlation |
| #312 | OpenAI-compatible provider (Ollama + vLLM + LM Studio) |
| #313 | Per-agent context budget — cap input tokens per call |
| #314 | CVE notification feed |

### v0.3 — Orchestration Depth

The agent-to-agent crown jewel.

| # | Title |
| --- | --- |
| #315 | Project progress tracking — todo-app scenario end-to-end |
| #316 | Custom proactive rules — user-defined patterns in YAML |
| #317 | Per-agent learning — baseline + anomaly detection |
| #318 | Multi-user / team mode |

---

## Working agreements

- **Issue per scope.** Every item above is its own GitHub issue with its own PR. No mega-PRs.
- **QA + tests per PR.** Unit tests for the pure logic, integration tests for the wire path, manual QA scenarios listed in the PR body for anything the user touches.
- **PRs land sequentially, in milestone order** (some can parallelise within a milestone — see issue dependencies in each).
- **Vision is the contract.** This doc is the source of truth. Issues reference it. PRs reference issues. Changes to the vision happen here, then propagate down.

*Generated 2026-05-17 alongside the v0.1.0 / v0.2 / v0.3 milestone creation.*
