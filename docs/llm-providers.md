# LLM providers

Foreman treats LLM providers as first-class — the wizard's Step 1 and the TUI's `[v]` Providers page both read from `registry/providers.json`. Configuring a provider stores an API key (or endpoint) in Foreman's encrypted secret store; agents that declare compatibility via `llm_compat` then surface it automatically.

## Tier-1 providers (bundled)

| Provider | id | Secret name | Endpoint required | Where to get |
|---|---|---|---|---|
| Anthropic | `anthropic` | `anthropic-api-key` | no | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| OpenAI | `openai` | `openai-api-key` | no | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Google Gemini | `gemini` | `gemini-api-key` | no | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| Local (Ollama) | `ollama` | — (no key) | **yes** — default `http://localhost:11434` | [ollama.com](https://ollama.com) |
| Custom OpenAI-compatible | `openai-compatible` | `openai-compatible-api-key` | **yes** | varies — Groq / Together / OpenRouter / vLLM / LiteLLM |

### Format hints

- **Anthropic** — key starts with `sk-ant-`
- **OpenAI** — key starts with `sk-`
- **Gemini** — key starts with `AI...`
- **Ollama** — no key; only an endpoint like `http://localhost:11434`
- **Custom OpenAI-compatible** — both endpoint URL and key required; format varies per upstream

## Wizard flow

```
Step 1/4 — LLM Providers
  picker  → choose providers you want to wire up
  values  → per-provider key (and endpoint when required)
  summary → "N providers configured"
```

Esc returns to the picker. Already-configured providers show a `(configured)` tag.

## TUI management

Hotkey `[v]` opens the Providers page. From there:

- `[n]` add a new provider value
- `[r]` rotate (replace the stored key/endpoint)
- `[d]` remove (also removes any dependent agent's stored LLM choice)
- `[s]` show — masked by default; `--reveal` flag on the CLI prints clear text

## Agent compatibility (`llm_compat`)

Every agent in `registry/agents.json` declares which providers it can talk to. The wizard's Step 2 (Agents) **grays out** agents whose required provider isn't configured — pick the provider first.

Current matrix:

| Agent | Anthropic | OpenAI | Gemini | Ollama | Custom |
|---|---|---|---|---|---|
| claude-code | ✓ | | | | |
| codex | | ✓ | | | |
| hermes | ✓ | ✓ | | | |
| openclaw | ✓ | ✓ | ✓ | | |
| zeroclaw | ✓ | ✓ | ✓ | | |
| generic-mcp | * | * | * | * | * |

`*` — `generic-mcp` has `llm_compat: []` which means "no constraint" (the user brings their own binary; Foreman just guards it).

## Adding a custom provider in v0.1.x

Not user-facing yet — for v0.1.x the tier-1 list is bundled. Maintainers can append entries to `registry/providers.json` per [`docs/registry-maintenance.md`](registry-maintenance.md). A user-editable upstream registry URL (`FOREMAN_REGISTRY_URL`) and `foreman registry validate` CLI are tracked for v0.2.

## Storage

Provider keys live in the same encrypted SQLite store as service tokens (AES-256-GCM, key derived from machine identity). They're never written to plain-text config files — agents that need the key receive it via Foreman's MCP `secrets/get` tool, which goes through the policy + audit pipeline.
