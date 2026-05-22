import { SecretNotFoundError, type SecretStore } from '../secret-store.js'
import { type LlmClient, LlmProviderError } from './client.js'
import type { LlmConfig, ProviderId } from './config.js'
import type { OAuthProviderId } from './oauth/oauth-providers.js'
import { makeAccessTokenProvider } from './oauth/token-refresh.js'
import { loadOAuthTokens } from './oauth/token-store.js'
import { AnthropicLlmClient } from './providers/anthropic.js'
import { CodexLlmClient } from './providers/codex.js'
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
// Failure modes the caller must handle separately:
//
//   - LlmProviderUnavailableError  → schema offers a provider whose runtime
//     impl hasn't shipped yet (e.g. ollama, openai_compatible — v0.2).
//     Surface a "configure a different provider" hint, not a 401.
//
//   - LlmCredentialMissingError    → impl is fine but the secret the config
//     points at is missing / unset. Surface "run `foreman secrets add X`".
//
//   - LlmOAuthLoginRequiredError   → `auth_mode: oauth` but no token bundle
//     in the store. Surface "run `foreman llm login <provider>`".

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

/** Raised when `auth_mode: oauth` is configured but the user has not signed
 *  in yet — no token bundle in the encrypted store. */
export class LlmOAuthLoginRequiredError extends Error {
  constructor(public readonly providerId: OAuthProviderId) {
    super(
      `Provider '${providerId}' is configured for OAuth but no tokens are ` +
        `stored. Run: foreman llm login ${providerId}`,
    )
    this.name = 'LlmOAuthLoginRequiredError'
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
      if (config.credentials.anthropic?.auth_mode === 'oauth') {
        return buildOAuthClient('anthropic', config.model, secretStore)
      }
      const apiKey = resolveSecret(
        config,
        secretStore,
        config.credentials.anthropic?.secret_name,
      )
      return new AnthropicLlmClient({ apiKey, model: config.model })
    }
    case 'openai': {
      if (config.credentials.openai?.auth_mode === 'oauth') {
        return buildOAuthClient('openai', config.model, secretStore)
      }
      const apiKey = resolveSecret(
        config,
        secretStore,
        config.credentials.openai?.secret_name,
      )
      return new OpenAILlmClient({ apiKey, model: config.model })
    }
    case 'gemini': {
      // Gemini has no subscription-OAuth equivalent today, so any
      // `auth_mode: oauth` here is silently ignored — Gemini stays on the
      // API-key path. Revisit if Google ever ships a Claude-Code-style
      // sign-in for Gemini.
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

/** Dispatch the OAuth-mode path: validate the user has signed in up front
 *  (so the error is contextual instead of surfacing on the first call), then
 *  return an OAuth-aware client wired to a self-refreshing token provider. */
function buildOAuthClient(
  providerId: OAuthProviderId,
  model: string,
  store: SecretStore,
): LlmClient {
  const tokens = loadOAuthTokens(store, providerId)
  if (!tokens) {
    throw new LlmOAuthLoginRequiredError(providerId)
  }
  const tokenProvider = makeAccessTokenProvider(store, providerId)
  if (providerId === 'anthropic') {
    return new AnthropicLlmClient({ tokenProvider, model })
  }
  // providerId === 'openai' → Codex (ChatGPT backend Responses API). Same
  // logical provider id from the factory's POV; OAuth-vs-API-key dispatches
  // to a different concrete client because the wire shape is different.
  return new CodexLlmClient({ tokenProvider, model })
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
