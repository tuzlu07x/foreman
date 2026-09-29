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
Step 1 of 6 — LLM Providers
  picker  → choose providers you want to wire up
  connect → Anthropic / OpenAI only: "API key" (the default) or
            "Claude / ChatGPT subscription"
  values  → per-provider key (and endpoint when required)
  summary → saved keys, and the subscriptions to sign in to after setup
```

For Anthropic and OpenAI the wizard first asks how to connect. **API key** is highlighted, so Enter leads to the key prompt. **Subscription** skips the key and signs you in through your browser when setup ends (`foreman llm login <provider>`). A key saved in this run always wins: no browser sign-in is queued for that provider. Gemini, Ollama and custom endpoints take a key or endpoint only.

On the summary, `y` (or Enter) continues; `n` or Esc goes back to the picker with your ticks kept and asks the key-or-subscription question again. In Step 2, a provider you can't pick yet (✗) says why on its row.

## TUI management

Hotkey `[v]` opens the Providers page. From there:

- `[n]` add a new provider value
- `[r]` rotate (replace the stored key/endpoint)
- `[d]` remove (also removes any dependent agent's stored LLM choice)
- `[s]` show — masked by default; `--reveal` flag on the CLI prints clear text

## Agent compatibility (`llm_compat`)

Every agent in `registry/agents.json` declares which providers it can talk to. The wizard's Step 3 (Agents) **hides** agents whose required provider isn't configured — pick the provider first.

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

## Foreman's brain on Ollama or an OpenAI-compatible endpoint

Foreman's own LLM (verification of risky calls, daily summaries) can run on any provider above, including a local Ollama server or any OpenAI-compatible Chat Completions endpoint. Both use the same client: it posts to `<base>/chat/completions` and lists models at Ollama's `/api/tags` or `<base>/models`.

In `foreman setup`, Step 2 (Foreman's brain):

- **Local — Ollama** asks for the base URL (default `http://localhost:11434`, or a remote Ollama server), then lists the models pulled on that server. For a server on this machine it also lists the bundled catalog, marking models that don't fit your RAM or disk and the ones that still need `ollama pull`. `[r]` re-checks after a pull. No key is needed.
- **Custom — OpenAI-compatible** offers the presets from `registry/llm-presets.json` (DeepSeek, OpenRouter, Groq, …) and **Other endpoint** for your own server (vLLM, LM Studio, LiteLLM). A preset asks for its API key; an own endpoint asks for the base URL, including its version path (e.g. `http://localhost:8000/v1`), and an optional key. Then pick the model from the endpoint's list, or type its id if the endpoint lists none.

What lands in `llm.yaml`:

```yaml
provider: ollama
model: llama3.2:3b
credentials:
  ollama:
    endpoint: http://localhost:11434 # add /v1 or not, both work
    secret_name: null # set to a secret name for an authenticated remote server
---
provider: openai_compatible
model: deepseek-chat
credentials:
  openai_compatible:
    endpoint_secret: deepseek-endpoint # the base URL, in the secret store
    key_secret: deepseek-api-key # omit for a keyless server
```

`endpoint_secret` (the URL stored in the secret store) wins over a plain `endpoint`. A base URL must be `http://` or `https://`, with no user:password, query string or fragment. The client refuses redirects, so the prompt and the key are only ever sent to the configured URL. `foreman doctor`'s `llm_credentials` check verifies the URL and key slots, and warns when a key would go over plain `http://` to a host that isn't on this machine.

**Cost.** Ollama calls cost $0 against the monthly budget. An OpenAI-compatible endpoint can serve any model at any price, so Foreman bills every call at the most expensive current price it knows ($10 / $50 per million input / output tokens, $30 / $180 for a `-pro` model), or at a known model's own price when that is higher (`openai/o1-pro` through OpenRouter). A response without token counts is billed as its worst case. The budget can run out early but never runs over; raise `budget.monthly_cap_usd` if a cheap endpoint trips it.

## Adding a custom provider in v0.1.x

Not user-facing yet: the tier-1 list is bundled. Maintainers can append entries to `registry/providers.json` per [`docs/registry-maintenance.md`](registry-maintenance.md). A user-editable upstream registry URL (`FOREMAN_REGISTRY_URL`) is planned; `foreman registry validate` checks the bundled files.

## Storage

Provider keys live in the same encrypted SQLite store as service tokens (AES-256-GCM, key derived from machine identity). They're never written to plain-text config files — agents that need the key receive it via Foreman's MCP `secrets/get` tool, which goes through the policy + audit pipeline.
