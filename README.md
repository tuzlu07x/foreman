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

The binary covers `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`. Windows users should use WSL2 for now.

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
- [`examples/mock-agent/`](examples/mock-agent/) — minimal MCP client that exercises the gateway end-to-end

## 5-minute demo

A scripted phishing scenario walks through the boot banner → idle dashboard → ⚠ approval modal → inspect → remember → audit log. Run it locally:

```bash
cd examples/phishing-scenario
./run-demo.sh
```

See [`examples/phishing-scenario/STORYBOARD.md`](examples/phishing-scenario/STORYBOARD.md) for the scene-by-scene script.

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

## Contributing

PRs and issues welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).

Repo: [github.com/tuzlu07x/foreman](https://github.com/tuzlu07x/foreman) · Issues: [`/issues`](https://github.com/tuzlu07x/foreman/issues)

## License

[MIT](./LICENSE) © 2026 Fatih Tuzlu
