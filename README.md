<img src="https://raw.githubusercontent.com/tuzlu07x/foreman/main/assets/mascot/foreman-beaver-256.png" alt="Foreman the Beaver" width="220" align="right" />

# Foreman

**Your local AI agents talk to each other. You should know what they're saying.**

A terminal-first guardian that mediates every call between the AI agents on your machine, scores each request for risk, and asks you before anything dangerous happens.

<!-- asciinema cast placeholder — drop in once recorded via `examples/phishing-scenario/` -->
<!-- [![asciicast](https://asciinema.org/a/PLACEHOLDER.svg)](https://asciinema.org/a/PLACEHOLDER) -->

---

## What is this?

- **Mediate** — every MCP call between your agents and their tools flows through Foreman.
- **Score** — heuristic rules flag secret-file access, outbound network, shell exec, and cross-agent calls.
- **Ask** — when a request crosses the threshold, you decide in the terminal: `[a]llow / [d]eny / [r]emember`.
- **Log** — every request hits a local SQLite store with full-text search (FTS5) for audit.

If a phishing email tells your assistant agent to share your `.env`, Foreman sees it, scores it 80/100, and asks before anything leaves your machine.

## Install

The fastest path — also installs Node 20 LTS via `nvm` if you don't already have it:

```bash
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
```

Pass `--uninstall` to remove the global package (`~/.foreman/` is left in place). Set `FOREMAN_VERSION` to pin a release, `FOREMAN_INSTALL_PREFIX` for a non-default npm prefix, or `FOREMAN_SKIP_NVM=1` to refuse the bootstrap path.

Homebrew (macOS / Linuxbrew):

```bash
brew tap tuzlu07x/foreman
brew install foreman
```

Standalone binary (no Node required — single ~75 MB file):

```bash
FOREMAN_USE_BINARY=1 \
  curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
# or grab directly from the release page
# https://github.com/tuzlu07x/foreman/releases/latest
```

The binary covers `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`.

**Windows:** Foreman runs through WSL2 (Ubuntu 22.04). Full walkthrough + the WSL2-specific quirks are in [`docs/windows-wsl2.md`](docs/windows-wsl2.md). Native Windows lands in v0.2+.

If you already manage Node yourself:

```bash
npm install -g foreman-agent       # Node >= 20 required
```

## Quick start

```bash
foreman init                 # create ~/.foreman/ (db, keypair, policy.yaml)
foreman start                # launch the TUI gateway

# Point an agent at Foreman's stdio MCP transport
foreman mcp-stdio
```

Wire an agent (Claude Code example):

```jsonc
// ~/.config/claude-code/mcp.json
{
  "mcpServers": {
    "foreman": { "command": "foreman", "args": ["mcp-stdio"] },
  },
}
```

Per-agent recipes:

- [`examples/claude-code/`](examples/claude-code/) — Anthropic's terminal coding agent
- [`examples/hermes-integration/`](examples/hermes-integration/) — Nous Research's personal assistant (Telegram + Discord) with a phishing-safe policy
- [`examples/openclaw-integration/`](examples/openclaw-integration/) — OpenClaw with a skill-compromise policy (CVE-2026-25253, Koi Security advisory)
- [`examples/mock-agent/`](examples/mock-agent/) — minimal MCP client that exercises the gateway end-to-end

## Supported integrations

Foreman ships three bundled catalogs that drive the wizard, the TUI management pages, and the CLI surfaces. Tier-1 entries below; see the linked guides for setup walkthroughs.

**LLM providers** ([docs/llm-providers.md](docs/llm-providers.md)) — Anthropic · OpenAI · Google Gemini · Ollama (local) · Custom OpenAI-compatible (Groq / Together / OpenRouter / vLLM / LiteLLM). Anthropic + OpenAI can also be authenticated by signing in with your Claude or ChatGPT subscription — `foreman llm login <provider>` ([details](docs/llm.md#subscription-oauth-claude--codex)).

**Agents** ([docs/agent-lifecycle.md](docs/agent-lifecycle.md)) — Claude Code · Codex · Hermes · OpenClaw · ZeroClaw · Generic MCP

**Services** ([docs/services.md](docs/services.md)) — Telegram · Discord · Slack · GitHub · Atlassian (Jira / Confluence) · Notion

Adding entries to the bundled catalogs is documented in [docs/registry-maintenance.md](docs/registry-maintenance.md). A user-editable upstream registry URL is on the v0.2 roadmap.

## 5-minute demo

A scripted phishing scenario walks through the boot banner → idle dashboard → ⚠ approval modal → inspect → remember → audit log. Run it locally:

```bash
cd examples/phishing-scenario
./run-demo.sh
```

See [`examples/phishing-scenario/STORYBOARD.md`](examples/phishing-scenario/STORYBOARD.md) for the scene-by-scene script.

For the longer "Pazartesi sabahı, todo-app from scratch" product narrative — the one the launch demo + onboarding hints draw from — see [`docs/scenario-pazartesi-sabahi.md`](docs/scenario-pazartesi-sabahi.md). It pins how Foreman behaves as a **pre-execution gate** (stops a `.env` leak before the call runs; doesn't undo afterwards) so the marketing copy + the code stay in sync.

## How is this different from…?

|                              | Foreman         | LangSmith / Helicone | Vanilla MCP               |
| ---------------------------- | --------------- | -------------------- | ------------------------- |
| Runs on your machine         | ✓ local-first   | cloud SaaS           | ✓ local                   |
| Mediates agent-to-agent      | ✓               | tracing only         | direct calls, no mediator |
| Asks before risky calls      | ✓ in terminal   | post-hoc dashboard   | no approval layer         |
| Audit log under your control | ✓ SQLite + FTS5 | their cloud          | no audit                  |
| Identity per agent           | ✓ Ed25519       | n/a                  | n/a                       |
| Open source                  | MIT             | proprietary          | spec                      |

The closest mental model: a personal-scale gateway with an audit log, for the multi-agent setups people now run at home.

## Roadmap

- **v0.1 — Today.** Single-machine gateway, heuristic risk scoring, Ink TUI, SQLite audit, MCP stdio.
- **v0.2 — Cross-machine mesh.** `foreman link`, optional Tailscale, master/child keys, primary-device approval.
- **v0.3 — Smart risk.** Optional Llama Prompt Guard 2, intent classification, token budget enforcement.
- **v0.4 — Ecosystem.** Plugin API, Cedar policy support, official Hermes / OpenClaw adapters.

## Documentation

- [`FOREMAN.md`](./FOREMAN.md) — full design doc (architecture, services, schema).
- [`FOREMAN-TUI.md`](./FOREMAN-TUI.md) — TUI / brand spec (palette, mascot, layout, screens).
- [`docs/llm-providers.md`](./docs/llm-providers.md) — LLM provider catalog reference.
- [`docs/services.md`](./docs/services.md) — service catalog + setup walkthroughs.
- [`docs/agent-lifecycle.md`](./docs/agent-lifecycle.md) — install / disable / enable / block / remove.
- [`docs/registry-maintenance.md`](./docs/registry-maintenance.md) — adding entries to the bundled catalogs.

## Contributing

PRs and issues welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).

Repo: [github.com/tuzlu07x/foreman](https://github.com/tuzlu07x/foreman) · Issues: [`/issues`](https://github.com/tuzlu07x/foreman/issues)

## License

[MIT](./LICENSE) © 2026 Fatih Tuzlu
