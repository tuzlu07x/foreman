<div align="center">

<img src="https://raw.githubusercontent.com/tuzlu07x/foreman/main/assets/mascot/foreman-beaver-256.png" alt="Foreman the Beaver" width="160" />

<img src="https://raw.githubusercontent.com/tuzlu07x/foreman/main/assets/foreman-banner.svg" alt="FOREMAN" width="520" />

### Run a whole crew of AI agents. Safely. On your own machine.

Foreman is the **security gateway and foreman** for Claude Code, Codex, Hermes, OpenClaw and
any MCP agent. Every tool call is **mediated, scored, approved by you when it matters, and
audited**, and your agents are organised like a company, with departments, reporting lines
and least-privilege access.

<br/>

[![verify](https://github.com/tuzlu07x/foreman/actions/workflows/verify.yml/badge.svg)](https://github.com/tuzlu07x/foreman/actions/workflows/verify.yml)
[![codeql](https://github.com/tuzlu07x/foreman/actions/workflows/codeql.yml/badge.svg)](https://github.com/tuzlu07x/foreman/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/foreman-agent?color=FF8C42&label=foreman-agent&logo=npm)](https://www.npmjs.com/package/foreman-agent)
[![license](https://img.shields.io/badge/license-MIT-FF8C42)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.12-00D084?logo=node.js&logoColor=white)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20WSL2-4D9DE0)](#install)

**[Website](https://foreman-agent.com)** · **[Install](#install)** · **[Quick start](#quick-start)** · **[MCP Hub](docs/mcp-hub.md)** · **[Foreman Org](docs/org.md)** · **[Security](SECURITY.md)** · **[Roadmap](#roadmap)**

</div>

<p align="center">
  <img src="docs/images/tui-approval.png" alt="Three agents waiting on approval in the Foreman TUI" width="860" />
</p>

<!-- asciinema cast placeholder — drop in once recorded via `examples/phishing-scenario/` -->

---

## Why

People now run several agents side by side: a coding agent in the editor, an assistant on
Telegram, a few MCP servers wired into both. Each one can read your files, run commands,
spend money and talk to the others. The failure modes are no longer theoretical:

- **Prompt injection and tool poisoning.** A web page, an email or an MCP tool description
  tells the agent to send your `.env` or SSH key somewhere.
- **Destructive commands.** An `rm -rf` expanded from an empty variable runs before anyone
  looks.
- **Supply chain.** An MCP server or skill silently changes after you trusted it.
- **Runaway cost.** Dozens of tool definitions sit in every context window, and agents
  delegate to agents in loops.

Foreman sits in the path of every call and handles all four locally, before anything runs.

## What you get

| | |
| --- | --- |
| 🛡️ **Mediate every call** | MCP tools, Claude Code's built-in tools (PreToolUse hook), Codex and ACP agents (Hermes, OpenClaw, ZeroClaw) all go through one pipeline: `policy.yaml`, then risk rules, then your approval, then an audit log. It fails closed: if Foreman can't decide, the call doesn't run. |
| 🧰 **[MCP Hub](docs/mcp-hub.md)** | `foreman mcp add github` once, and every agent gets it, mediated. There is a curated catalog of 19 servers (GitHub, filesystem, Playwright, Notion, Stripe, Sentry, Brave, Exa, Discord, X, YouTube, App Store / Google Play, …). Secrets stay in Foreman's encrypted store, never in agent configs. |
| 🧪 **Tool-poisoning & rug-pull defence** | Tool descriptions are scanned for hidden instructions. Definitions are pinned on first use, and a tool that changes later is withheld until you trust it again. Results are redacted for secrets and flagged for injected instructions. |
| 🏢 **[Foreman Org](docs/org.md)** | `foreman org init --template startup` sets up a CEO, CTO, CMO, CFO and teams, each role filled by the agent you choose. Delegation follows reporting lines, and each department sees only the tools it needs. |
| 🖥️ **[A terminal you can run your crew from](docs/tui.md)** | A live dashboard, a queue for every agent waiting on you, an inbox of everything you missed, and a `:` console: `write codex …`, `assign marketing …`, `approve`. No chat app required. |
| 📱 **Approve from anywhere** | Decide in the TUI, or with one tap in Telegram, Slack or Discord. Buttons carry HMAC-tagged tokens and reach Foreman over connections only it holds (Telegram approval bot, Slack Socket Mode, the Discord Gateway), so no agent can approve for you. `/foreman status`, `/foreman write codex …` work from Slack and Discord too. Alerts and digests also go to email and ntfy phone push. |
| 💸 **Fewer tokens** | Lazy tool discovery cut the listing for the official filesystem server from ~2,000 tokens to ~190. Descriptions are clipped, oversized results truncated, and routine roles can run on cheaper models. |
| 🔒 **Tamper protection** | An agent that tries to edit Foreman's database, policy, keys or its own hook/MCP wiring is caught as a critical risk. |
| 📝 **Local audit** | Every decision is stored in SQLite with full-text search. Secrets are masked; files are owner-only. No cloud, no telemetry. |

## Install

Needs Node **22.12+**. The installer sets up Node 22 LTS through `nvm` if you don't have it:

```bash
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
```

<details>
<summary><b>Other ways</b> · Homebrew · npm · installer options</summary>

<br/>

```bash
brew tap tuzlu07x/foreman && brew install foreman-agent   # macOS / Linuxbrew
npm install -g foreman-agent                              # Node >= 22.12
```

| Variable / flag          | Effect                                                     |
| ------------------------ | ---------------------------------------------------------- |
| `FOREMAN_VERSION=0.1.6`  | Pin a specific release                                     |
| `FOREMAN_INSTALL_PREFIX` | Use a non-default npm prefix                               |
| `FOREMAN_SKIP_NVM=1`     | Refuse the nvm bootstrap path                              |
| `--uninstall`            | Remove the global package (Foreman's data is left in place) |

**Windows:** run Foreman inside WSL2. See [`docs/windows-wsl2.md`](docs/windows-wsl2.md).

</details>

## Quick start

**See it first, in a sandbox:**

```bash
foreman demo
```

A made-up company of agents (a CEO, a CTO, an engineer, a CMO and a CFO) works through a day
while you watch the real TUI. You'll see:

- department messages, and a task handed down the org chart;
- an agent reaching for `.env` (press `a` or `d`);
- a poisoned instruction blocked;
- marketing going over its daily budget;
- the CEO's report landing in your inbox.

The agents are stand-ins with canned answers, and they're the only agent CLIs on the demo's
`PATH`. Everything lives in a throwaway folder with its own `FOREMAN_HOME`, and no keys are
needed. Your real agents, files and `~/.foreman` are never touched.

**Then set up your own:**

```bash
foreman init            # identity, policy, encrypted secret store, audit DB
foreman start           # guided setup on first run, then the live TUI
```

**Connect Claude Code.** Wire its MCP connection, then gate its built-in tools (Bash, Read,
Write, WebFetch, …) with the PreToolUse hook:

```bash
foreman agent add claude-code            # or: claude mcp add --scope user foreman -- foreman mcp-stdio --source claude-code
foreman agent hook install claude-code
```

**Give every agent GitHub, safely:**

```bash
foreman mcp add github && foreman secrets add github-pat
foreman mcp tools github          # scan, pin, show token cost
```

**Organise your agents:**

```bash
foreman org init --template startup --company "Acme"
foreman org show
foreman org assign marketing "draft the launch post for Friday"
```

**Get alerts on your phone:**

```bash
foreman notify ntfy-setup         # or configure Telegram for tap-to-approve
```

**Run it from the terminal.** In `foreman start`, press `:` and type what you'd type in chat:

```
› status
› assign engineering add rate limiting to the public API
› codex write tests for src/rate-limit.ts
› approve
```

`n` opens your inbox, and `Tab` moves between pages. From any shell, `foreman inbox`
shows the same notifications. See [`docs/tui.md`](docs/tui.md).

Then watch it work: `foreman log tail --follow`, `foreman doctor`, `foreman policy show`.

## How it works

```
 you ── TUI · Telegram · Slack · Discord (approve + command) · email · ntfy (alerts)
  │
  ▼
┌───────────────────────────── FOREMAN (local) ─────────────────────────────┐
│  policy.yaml ─► risk rules ─► approval ─► audit (SQLite + FTS5)           │
│      ▲            secret paths · shell · network · injection ·            │
│      │            loops · responsibility · tamper protection              │
│  org.yaml: departments · reporting lines · per-department MCP access      │
│  MCP Hub: catalog · poisoning scan · pins · result guard · token budget   │
└───────▲──────────────────▲──────────────────▲─────────────────▲───────────┘
        │ MCP (stdio)      │ PreToolUse hook  │ ACP / codex     │ upstream MCP
   any MCP agent      Claude Code      Hermes · OpenClaw ·   GitHub · Notion ·
                                        ZeroClaw · Codex      Stripe · …
```

Foreman is a **pre-execution gate**. It decides before a call runs; it does not undo side
effects afterwards. See [`docs/architecture.md`](docs/architecture.md).

## Supported integrations

| Category | Integrations |
| --- | --- |
| **Agents** ([guide](docs/agent-lifecycle.md)) | Claude Code · Codex · Hermes · OpenClaw · ZeroClaw · any MCP agent |
| **MCP servers** ([hub](docs/mcp-hub.md)) | GitHub · Filesystem · Memory · Playwright · Chrome DevTools · Notion · Sentry · Stripe · Brave · Exa · Firecrawl · Context7 · Figma · Resend · Discord · X · YouTube · App Store Connect · App Store + Google Play · your own (stdio or HTTPS) |
| **Channels** ([guide](docs/notifications.md)) | Telegram, Slack and Discord (tap-to-approve, `/foreman` commands) · Email (SMTP) · ntfy · Webhook (signed) · OS notifications |
| **LLM providers** ([guide](docs/llm-providers.md)), for Foreman's optional smart features | Anthropic · OpenAI · Google Gemini · Ollama (local) · any OpenAI-compatible endpoint |

## How is this different from…

|  | Foreman | Agent built-in permissions | MCP gateways / registries | Tracing / observability |
| --- | --- | --- | --- | --- |
| Covers several agents at once | ✅ | ❌ one agent each | ✅ MCP only | ✅ |
| Human approval before risky calls | ✅ TUI + phone | ✅ in that agent's UI | rarely | ❌ after the fact |
| Tool poisoning + rug-pull checks | ✅ | ❌ | some | ❌ |
| Agent-to-agent delegation rules (org chart) | ✅ | ❌ | ❌ | ❌ |
| Runs locally, no account | ✅ | ✅ | varies | usually cloud |

## Documentation

| Doc | What's inside |
| --- | --- |
| [`docs/tui.md`](docs/tui.md) | The TUI: approvals queue, command console, inbox, keys |
| [`docs/mcp-hub.md`](docs/mcp-hub.md) | MCP Hub: catalog, `mcp.yaml`, security, token budget |
| [`docs/org.md`](docs/org.md) | Foreman Org: departments, roles, delegation, upgrades |
| [`docs/notifications.md`](docs/notifications.md) | Telegram, Slack, Discord, email, ntfy, webhook |
| [`docs/architecture.md`](docs/architecture.md) | Mediator pipeline, approval flow, data model |
| [`docs/detection.md`](docs/detection.md) | Risk rules and scoring |
| [`docs/agent-lifecycle.md`](docs/agent-lifecycle.md) | Install / disable / block / remove agents |
| [`docs/install.md`](docs/install.md) | Install, upgrade, uninstall |
| [`SECURITY.md`](SECURITY.md) | Threat model, limits, reporting |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed |

## Roadmap

- ✅ **Shipped:** the mediator across MCP, hooks, ACP and codex · risk engine with tamper
  protection · MCP Hub with a curated catalog · tool-poisoning and rug-pull defence · Foreman
  Org · TUI control surface (approval queue, command console, inbox) · approvals and
  `/foreman` from Telegram, Slack and Discord · email / ntfy alerts · lazy tool discovery.
- 🔜 **Next:** per-department cost reports and budgets · department channels on Slack /
  Discord with Foreman in the loop · a shared hub daemon (one upstream per server, ~50 ms
  hooks) · OAuth for hosted MCP servers · approval escalation along the org chart.
- 🧭 **Later:** a desktop / menu-bar app · per-agent identity tokens · cross-machine mesh ·
  a local classifier model (Prompt Guard) for borderline calls.

## Contributing

PRs and issues are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md), the
[agent contribution guide](./AGENTS.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).
Every PR runs the **verify** check.

---

<div align="center">

**[MIT](./LICENSE)** © 2026 Fatih Tuzlu

<sub>Built for people running more than one agent. 🦫 Foreman the Beaver is watching.</sub>

</div>
