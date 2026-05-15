# Registry maintenance guide

Foreman ships three bundled catalogs that drive the wizard, the TUI management pages, and the CLI surfaces:

| Catalog | Path | Owns |
|---|---|---|
| Agents | `registry/agents.json` | What you can install + register as a Foreman-guarded agent |
| Providers | `registry/providers.json` | LLM providers (Anthropic, OpenAI, Gemini, Ollama, custom) — secret + endpoint shapes |
| Services | `registry/services.json` | 3rd-party integrations (Telegram, Discord, GitHub, …) with multi-step setup walkthroughs |

This guide is for **maintainers** who need to add an agent / provider / service, or update an existing entry without breaking downstream consumers.

## The contract: cross-catalog references

Each catalog has fields that point at ids in another catalog. The catalog parser only validates each file in isolation — cross-catalog references can drift if you rename a provider id but forget to update the agents that depend on it. The `validateAgentsAgainstCatalogs(agents, providers, services)` helper exists to catch these typos:

```ts
import {
  loadBundledProviders,
  loadBundledRegistry,
  loadBundledServices,
  validateAgentsAgainstCatalogs,
} from "foreman-agent/registry-catalog"; // hypothetical export path

const result = validateAgentsAgainstCatalogs(
  loadBundledRegistry(),
  loadBundledProviders(),
  loadBundledServices(),
);
if (!result.ok) {
  for (const issue of result.issues) {
    console.error(issue);
  }
  process.exit(1);
}
```

The unit test `tests/core/cross-catalog-validation.test.ts` runs this against the bundled catalogs on every `npm test` so a stale reference can't be merged.

### Reference fields

- `agents[].llm_compat: string[]` → must each be an `id` in `providers.providers`
- `agents[].optional_services: string[]` → must each be an `id` in `services.services`
- `services.services[].used_by_agents: string[]` → must each be an `id` in `agents.agents`

The provider catalog doesn't reference the other two — providers are leaf nodes.

## Adding an agent

1. Append a new entry to `registry/agents.json`. Required fields (see the existing entries for shape):
   - `id` — lowercase kebab-case; e.g. `nemo-claw`
   - `name`, `tagline`, `homepage`
   - `install` block: `npm` / `brew` / `script` / `binary` overrides as appropriate for the agent's installer
   - `config_paths` — places Foreman looks for the agent's config file when injecting the MCP block
   - `required_secrets` / `optional_secrets` — secret-store key names
   - `llm_compat` — provider ids the agent can run on (empty = "no constraint")
   - `optional_services` — service ids the agent can integrate with
   - `mcp_compatible: true`
   - `supported_versions`, `min_foreman_version`
2. **Test the install path on a clean VM** before publishing. The `verify_command` (when we add it) doubles as a fast smoke; for now manually run `foreman setup` on a fresh box and pick this agent.
3. If the agent declares `optional_services`, **also update the matching services' `used_by_agents` arrays** so the wizard's "Used by:" line on the Services step shows accurate consumers.
4. Run `npm test`; the bundled-catalog cross-validation will fail loudly if you forgot the reverse mapping.

### Identity hook caveats

Some agent runtimes weight their core system prompt above any user-supplied identity file (see #132 for the Hermes case). When this matters, set the entry's `identity_path` so Foreman writes its SOUL.md there, and document the limitation alongside the entry — users running `foreman identity push` deserve to know whether the push actually changes the agent's persona.

## Adding a provider

1. Append a new entry to `registry/providers.json`. Required fields:
   - `id` — kebab-case
   - `name`, `description`
   - `secret_name` — what to store the API key under (`null` for endpoint-only providers like Ollama)
   - `where_to_get` — URL the wizard / TUI surfaces (`null` for custom / generic providers)
   - `format_hint` — short text like "starts with sk-ant-"
   - `instructions` — array of short steps the wizard renders in order
   - `endpoint_default` / `endpoint_required` — for providers like Ollama that need an endpoint URL, or custom OAI-compatible that need both endpoint AND key
2. Test from the wizard's Step 1 — pick the new provider, walk the value-entry flow, confirm the summary lists it correctly.
3. If any agent should be able to use this new provider, add the new id to their `llm_compat` array in `agents.json`.

## Adding a service

1. Append a new entry to `registry/services.json`. Required fields:
   - `id` — kebab-case
   - `name`, `description`
   - `secret_name` — token name
   - `where_to_get` — URL
   - `format_hint`
   - `setup_steps` — array of steps; **must be at least one** (Zod-enforced). These render verbatim in the wizard's Step 3 + the TUI Services page's `[w]` walkthrough overlay
   - `used_by_agents` — agent ids that integrate with this service
   - `open_url_hotkey: boolean` — if true, the wizard / TUI wraps `where_to_get` with OSC 8 escape sequences so the URL is clickable in modern terminals
2. **Add the reverse mapping** in each consuming agent's `optional_services` array in `agents.json`.
3. Manual smoke: from the TUI Services page (`V`), press `[n]` on the new entry, follow the walkthrough, confirm token storage works.

## Renaming an id

This is the most error-prone operation. If you must rename:

1. Update the `id` in the source catalog
2. Search both other catalogs for references to the old id and update them — `git grep "old-id"` is your friend
3. Run `npm test` — `validateAgentsAgainstCatalogs` flags stragglers loudly
4. Bump the `min_foreman_version` on the renamed entry if old Foreman builds would break

In general, prefer **adding a new entry** + deprecating the old one for a release rather than renaming in place.

## Local validation

```bash
# Cross-catalog typo check + every existing zod test:
npm test -- tests/core/cross-catalog-validation.test.ts

# Full registry test suite:
npm test -- tests/core
```

## Future tooling (not yet built)

- `foreman registry validate` CLI — runs the cross-catalog check + each entry's `verify_command` against a clean container
- `foreman registry diff` — shows what would change if you swapped to a custom upstream registry URL via `FOREMAN_REGISTRY_URL`
- CI workflow that polls every `where_to_get` URL on PRs that touch the catalogs (liveness check)

These are out of scope for v0.1.x; track in #161.
