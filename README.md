<div align="center">

<img src="https://raw.githubusercontent.com/tuzlu07x/foreman/main/assets/mascot/foreman-beaver-256.png" alt="Foreman the Beaver" width="180" />

# Foreman

### Your local AI agents talk to each other. You should know what they're saying.

A terminal-first guardian that **mediates every call** between the AI agents on your
machine, **scores each request for risk**, and **asks you** before anything dangerous happens.

<br/>

[![npm](https://img.shields.io/npm/v/foreman-agent?color=FF8C42&label=foreman-agent&logo=npm)](https://www.npmjs.com/package/foreman-agent)
[![license](https://img.shields.io/badge/license-MIT-FF8C42)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-00D084?logo=node.js&logoColor=white)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20WSL2-4D9DE0)](#install)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-FFC542)](./CONTRIBUTING.md)

<br/>

**[Install](#install)** · **[Quick start](#quick-start)** · **[Docs](#documentation)** · **[Integrations](#supported-integrations)** · **[Roadmap](#roadmap)**

</div>

<!-- asciinema cast placeholder — drop in once recorded via `examples/phishing-scenario/` -->
<!-- [![asciicast](https://asciinema.org/a/PLACEHOLDER.svg)](https://asciinema.org/a/PLACEHOLDER) -->

---

## 🦫 What is this?

When your machine runs Claude Code, Hermes, OpenClaw and friends side by side, they call
each other and reach for your files, your network, and your shell — and nobody is watching.
Foreman sits in the middle of all of it.

|                |                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- |
| 🛡️ **Mediate** | Every MCP call between your agents and their tools flows through Foreman.                          |
| 📊 **Score**   | Heuristic rules flag secret-file access, outbound network, shell exec, and cross-agent calls.      |
| 🙋 **Ask**     | When a request crosses the threshold, you decide in the terminal: `[a]llow / [d]eny / [r]emember`. |
| 📝 **Log**     | Every request hits a local SQLite store with full-text search (FTS5) for audit.                    |

> If a phishing email tells your assistant agent to share your `.env`, Foreman sees it,
> scores it **80/100**, and asks before anything leaves your machine.

---

## Install

The fastest path — also installs Node 20 LTS via `nvm` if you don't already have it:

```bash
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
```

<details>
<summary><b>Other ways to install</b> — Homebrew · standalone binary · npm</summary>

<br/>

**Homebrew** (macOS / Linuxbrew):

```bash
brew tap tuzlu07x/foreman
brew install foreman
```

**Standalone binary** (no Node required — single ~75 MB file). Covers `darwin-arm64`,
`darwin-x64`, `linux-x64`, and `linux-arm64`:

```bash
FOREMAN_USE_BINARY=1 \
  curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
# or grab it directly from https://github.com/tuzlu07x/foreman/releases/latest
```

**npm** (if you already manage Node yourself, `>= 20` required):

```bash
npm install -g foreman-agent
```

</details>

<details>
<summary><b>Install script options</b> — pin a version, custom prefix, uninstall</summary>

<br/>

| Variable / flag          | Effect                                                     |
| ------------------------ | ---------------------------------------------------------- |
| `FOREMAN_VERSION=0.1.0`  | Pin a specific release                                     |
| `FOREMAN_INSTALL_PREFIX` | Use a non-default npm prefix                               |
| `FOREMAN_SKIP_NVM=1`     | Refuse the nvm bootstrap path                              |
| `--uninstall`            | Remove the global package (`~/.foreman/` is left in place) |

</details>

> **🪟 Windows:** Foreman runs through **WSL2** (Ubuntu 22.04) today — it assumes a POSIX
> shell, so native PowerShell / `npm install` on Windows isn't supported yet. Full
> walkthrough and the WSL2-specific quirks are in [`docs/windows-wsl2.md`](docs/windows-wsl2.md).
> Native Windows lands in **v0.2+**.

---

## Quick start

```bash
foreman init                 # create ~/.foreman/ (db, keypair, policy.yaml)
foreman start                # launch the TUI gateway

# Point an agent at Foreman's stdio MCP transport
foreman mcp-stdio
```

Wire an agent (**Claude Code** example):

```jsonc
// ~/.config/claude-code/mcp.json
{
  "mcpServers": {
    "foreman": { "command": "foreman", "args": ["mcp-stdio"] },
  },
}
```

Then watch it work:

```bash
foreman log tail --follow    # live request stream
foreman agent list           # registered agents
foreman policy show          # active rules
```

**Per-agent recipes:**

- [`examples/claude-code/`](examples/claude-code/) — Anthropic's terminal coding agent
- [`examples/hermes-integration/`](examples/hermes-integration/) — Nous Research's personal assistant (Telegram + Discord) with a phishing-safe policy
- [`examples/openclaw-integration/`](examples/openclaw-integration/) — OpenClaw with a skill-compromise policy (CVE-2026-25253, Koi Security advisory)
- [`examples/mock-agent/`](examples/mock-agent/) — minimal MCP client that exercises the gateway end-to-end

---

## ▶️ 5-minute demo

A scripted phishing scenario walks through the boot banner → idle dashboard → ⚠ approval
modal → inspect → remember → audit log:

```bash
cd examples/phishing-scenario
./run-demo.sh
```

See [`examples/phishing-scenario/STORYBOARD.md`](examples/phishing-scenario/STORYBOARD.md)
for the scene-by-scene script, and
[`docs/scenario-pazartesi-sabahi.md`](docs/scenario-pazartesi-sabahi.md) for the longer
product narrative that pins Foreman as a **pre-execution gate** (it stops a `.env` leak
_before_ the call runs — it doesn't undo afterwards).

---

## Supported integrations

Foreman ships three bundled catalogs that drive the wizard, the TUI management pages, and
the CLI. Tier-1 entries below; see the linked guides for setup walkthroughs.

| Category                                              | Integrations                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **🤖 Agents** ([guide](docs/agent-lifecycle.md))      | Claude Code · Codex · Hermes · OpenClaw · ZeroClaw · Generic MCP                                                               |
| **🧠 LLM providers** ([guide](docs/llm-providers.md)) | Anthropic · OpenAI · Google Gemini · Ollama (local) · Custom OpenAI-compatible (Groq / Together / OpenRouter / vLLM / LiteLLM) |
| **🔌 Services** ([guide](docs/services.md))           | Telegram · Discord · Slack · GitHub · Atlassian (Jira / Confluence) · Notion                                                   |

Anthropic + OpenAI can also be authenticated by signing in with your Claude or ChatGPT
subscription — `foreman llm login <provider>` ([details](docs/llm.md#subscription-oauth-claude--codex)).

<details>
<summary><b>Action-mediation transport</b> — how each integration is wired (#552 / #445)</summary>

<br/>

Every integration falls into one of three categories Foreman handles uniformly.

| Transport                             | Agents                                                                                    | How it works                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bridge (JSON-RPC stdio)**           | Codex (`codex exec-server`), Hermes / OpenClaw / ZeroClaw (`<binary> acp` — ACP standard) | Foreman spawns the agent as a child process and mediates every approval it emits over JSON-RPC. Bidirectional: Foreman injects user directives via `session/prompt` (ACP) or `turn/start` (codex). Risk rules fire before each shell / file / network action runs. |
| **Wrap (synthetic Telegram updates)** | Reserved for hypothetical chat-only daemon agents                                         | Replaces the agent's Telegram poller with a Foreman-controlled wrap process that injects synthetic owner-originated updates. Documented + tested; no current agent needs it.                                                                                       |
| **Legacy hybrid**                     | Claude Code (via PreToolUse hook), Generic MCP                                            | PreToolUse hook for claude-code; chat-post relay for everything else. Pre-bridge baseline that still works for agents without a programmable transport.                                                                                                            |

Audit which transport each agent uses via `foreman agents show <id>`. The wizard surfaces
it at install time; `foreman doctor` flags missing ACP binaries.

</details>

Adding entries to the bundled catalogs is documented in
[`docs/registry-maintenance.md`](docs/registry-maintenance.md). A user-editable upstream
registry URL is on the v0.2 roadmap.

---

## How is this different from…?

Tracing tools tell you _what happened_. Foreman decides _what's allowed to happen_ —
locally, before the call lands.

|                              | Foreman          | LangSmith / Helicone | Vanilla MCP               |
| ---------------------------- | ---------------- | -------------------- | ------------------------- |
| Runs on your machine         | ✅ local-first   | ☁️ cloud SaaS        | ✅ local                  |
| Mediates agent-to-agent      | ✅               | tracing only         | direct calls, no mediator |
| Asks before risky calls      | ✅ in terminal   | post-hoc dashboard   | no approval layer         |
| Audit log under your control | ✅ SQLite + FTS5 | their cloud          | no audit                  |
| Identity per agent           | ✅ Ed25519       | n/a                  | n/a                       |
| Open source                  | ✅ MIT           | proprietary          | spec                      |

The closest mental model: a personal-scale gateway with an audit log, for the multi-agent
setups people now run at home.

---

## Roadmap

- ✅ **v0.1 — Today.** Single-machine gateway, heuristic risk scoring, Ink TUI, SQLite audit, MCP stdio.
- 🔜 **v0.2 — Cross-machine mesh.** `foreman link`, optional Tailscale, master/child keys, primary-device approval.
- 🧠 **v0.3 — Smart risk.** Optional Llama Prompt Guard 2, intent classification, token budget enforcement.
- 🧩 **v0.4 — Ecosystem.** Plugin API, Cedar policy support, official Hermes / OpenClaw adapters.

---

## Documentation

| Doc                                                              | What's inside                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| [`FOREMAN.md`](./FOREMAN.md)                                     | Full design doc — architecture, services, schema              |
| [`FOREMAN-TUI.md`](./FOREMAN-TUI.md)                             | TUI / brand spec — palette, mascot, layout, screens           |
| [`docs/architecture.md`](./docs/architecture.md)                 | Runtime behavior — mediator pipeline, approval flow, sessions |
| [`docs/agent-lifecycle.md`](./docs/agent-lifecycle.md)           | Install / disable / enable / block / remove agents            |
| [`docs/llm-providers.md`](./docs/llm-providers.md)               | LLM provider catalog reference                                |
| [`docs/services.md`](./docs/services.md)                         | Service catalog + setup walkthroughs                          |
| [`docs/registry-maintenance.md`](./docs/registry-maintenance.md) | Adding entries to the bundled catalogs                        |

---

## Contributing

PRs and issues welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md).

**Repo:** [github.com/tuzlu07x/foreman](https://github.com/tuzlu07x/foreman) ·
**Issues:** [`/issues`](https://github.com/tuzlu07x/foreman/issues)

---

<div align="center">

**[MIT](./LICENSE)** © 2026 Fatih Tuzlu

<sub>Built for developers running more than one agent. 🦫 Foreman the Beaver is watching.</sub>

</div>
