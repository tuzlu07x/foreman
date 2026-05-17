import { SecretNotFoundError, type SecretStore } from '../secret-store.js'
import { type LlmClient, LlmProviderError } from './client.js'
import type { LlmConfig, ProviderId } from './config.js'
import { AnthropicLlmClient } from './providers/anthropic.js'
import { GeminiLlmClient } from './providers/gemini.js'
import { OpenAILlmClient } from './providers/openai.js'

// =============================================================================
// LLM client factory (#296)
// =============================================================================
//
// Closes the "only anthropic is implemented" hardcoded throws in llm-cli.ts
// and start.ts. Every caller goes through `buildLlmClient(config, store)` and
// gets back the right concrete `LlmClient` (or a typed error explaining why
// not).
//
// Two failure modes the caller must handle separately:
//
//   - LlmProviderUnavailableError → schema offers a provider whose runtime
//     impl hasn't shipped yet (e.g. ollama, openai_compatible — v0.2).
//     Surface a "configure a different provider" hint, not a 401.
//
//   - LlmCredentialMissingError   → impl is fine but the secret the config
//     points at is missing / unset. Surface "run `foreman secrets add X`".

export class LlmProviderUnavailableError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(
      `LLM provider '${providerId}' is not implemented in this build. ` +
        `Configure one of: anthropic, openai, gemini.`,
    )
    this.name = 'LlmProviderUnavailableError'
  }
}

export class LlmCredentialMissingError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    public readonly secretName: string | null,
  ) {
    super(
      secretName
        ? `Provider '${providerId}' references secret '${secretName}' which is not in the store. ` +
            `Run: foreman secrets add ${secretName}`
        : `Provider '${providerId}' has no secret_name configured in llm.yaml`,
    )
    this.name = 'LlmCredentialMissingError'
  }
}

/**
 * Resolve a usable LlmClient for the configured provider. Throws explicitly
 * so the caller can render a contextual error — no silent nulls.
 */
export function buildLlmClient(
  config: LlmConfig,
  secretStore: SecretStore,
): LlmClient {
  switch (config.provider) {
    case 'anthropic': {
      const apiKey = resolveSecret(
        config,
        secretStore,
        config.credentials.anthropic?.secret_name,
      )
      return new AnthropicLlmClient({ apiKey, model: config.model })
    }
    case 'openai': {
      const apiKey = resolveSecret(
        config,
        secretStore,
        config.credentials.openai?.secret_name,
      )
      return new OpenAILlmClient({ apiKey, model: config.model })
    }
    case 'gemini': {
      const apiKey = resolveSecret(
        config,
        secretStore,
        config.credentials.gemini?.secret_name,
      )
      return new GeminiLlmClient({ apiKey, model: config.model })
    }
    case 'ollama':
    case 'openai_compatible':
      // Schema accepts these (so users can plan-config them) but the runtime
      // impls land in v0.2 (#312). Distinct error so the CLI can render the
      // right "configure something else" hint.
      throw new LlmProviderUnavailableError(config.provider)
    default: {
      // Exhaustiveness check — if ProviderIdSchema grows a new case, TS
      // surfaces it here at build time.
      const _exhaustive: never = config.provider
      throw new LlmProviderUnavailableError(_exhaustive)
    }
  }
}

function resolveSecret(
  config: LlmConfig,
  store: SecretStore,
  secretName: string | null | undefined,
): string {
  if (!secretName) {
    throw new LlmCredentialMissingError(config.provider, null)
  }
  try {
    return store.get(secretName)
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      throw new LlmCredentialMissingError(config.provider, secretName)
    }
    throw err
  }
}

// Re-exports kept so existing imports of LlmProviderError from this module
// still work (some callers grab both the factory + the error type).
export { LlmProviderError }
