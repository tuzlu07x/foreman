import { SecretNotFoundError, type SecretStore } from '../secret-store.js'
import { type LlmClient, LlmProviderError } from './client.js'
import type { LlmConfig, ProviderId } from './config.js'
import {
  checkLlmBaseUrl,
  OLLAMA_DEFAULT_BASE_URL,
  ollamaOpenAiBase,
} from './endpoint.js'
import type { OAuthProviderId } from './oauth/oauth-providers.js'
import { makeAccessTokenProvider } from './oauth/token-refresh.js'
import { loadOAuthTokens } from './oauth/token-store.js'
import { AnthropicLlmClient } from './providers/anthropic.js'
import { CodexLlmClient } from './providers/codex.js'
import { GeminiLlmClient } from './providers/gemini.js'
import { OpenAILlmClient } from './providers/openai.js'
import { OpenAICompatibleLlmClient } from './providers/openai-compatible.js'

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
//   - LlmProviderUnavailableError  → a provider id this build has no client
//     for. Only reachable if ProviderIdSchema grows a case the switch below
//     doesn't handle yet.
//
//   - LlmCredentialMissingError    → impl is fine but the secret the config
//     points at is missing / unset. Surface "run `foreman secrets add X`".
//     LlmEndpointError (a subclass) covers a missing or invalid base URL for
//     ollama / openai_compatible, so every caller that already treats a
//     missing credential as "run heuristic-only" handles it too.
//
//   - LlmOAuthLoginRequiredError   → `auth_mode: oauth` but no token bundle
//     in the store. Surface "run `foreman llm login <provider>`".

export class LlmProviderUnavailableError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(
      `LLM provider '${providerId}' is not implemented in this build. ` +
        `Configure one of: anthropic, openai, gemini, ollama, openai_compatible.`,
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

/** The base URL of an ollama / openai_compatible brain is unset, missing
 *  from the secret store, or not an http(s) URL. */
export class LlmEndpointError extends LlmCredentialMissingError {
  constructor(providerId: ProviderId, secretName: string | null, reason: string) {
    super(providerId, secretName)
    this.message = `Provider '${providerId}' endpoint: ${reason}`
    this.name = 'LlmEndpointError'
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
    case 'ollama': {
      const cred = config.credentials.ollama
      const baseUrl = resolveEndpoint(config, secretStore, OLLAMA_DEFAULT_BASE_URL)
      return new OpenAICompatibleLlmClient({
        providerId: 'ollama',
        baseUrl: ollamaOpenAiBase(baseUrl),
        model: config.model,
        // Keyless unless a secret is named (a remote, authenticated server).
        apiKey: cred?.secret_name
          ? resolveSecret(config, secretStore, cred.secret_name)
          : null,
      })
    }
    case 'openai_compatible': {
      const cred = config.credentials.openai_compatible
      const baseUrl = resolveEndpoint(config, secretStore, null)
      // `key_secret` is what the schema defaults and the wizard write;
      // `secret_name` keeps an older hand-written block working. Neither set
      // means a keyless endpoint (a local vLLM / LM Studio, say).
      const keySecret = cred?.key_secret ?? cred?.secret_name ?? null
      return new OpenAICompatibleLlmClient({
        providerId: 'openai_compatible',
        baseUrl,
        model: config.model,
        apiKey: keySecret ? resolveSecret(config, secretStore, keySecret) : null,
      })
    }
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

/** Base URL for ollama / openai_compatible: `endpoint_secret` (the name the
 *  wizard's Step 1 and presets store the URL under) wins over a plain
 *  `endpoint`; Ollama falls back to its local default. */
function resolveEndpoint(
  config: LlmConfig,
  store: SecretStore,
  fallback: string | null,
): string {
  const cred =
    config.provider === 'ollama' || config.provider === 'openai_compatible'
      ? config.credentials[config.provider]
      : undefined
  const endpointSecret = cred?.endpoint_secret ?? null
  let raw: string | null = null
  if (endpointSecret) {
    try {
      raw = store.get(endpointSecret)
    } catch (err) {
      if (err instanceof SecretNotFoundError) {
        throw new LlmEndpointError(
          config.provider,
          endpointSecret,
          `secret '${endpointSecret}' is not in the store. Run: foreman secrets add ${endpointSecret}`,
        )
      }
      throw err
    }
  } else {
    raw = cred?.endpoint ?? fallback
  }
  if (!raw) {
    throw new LlmEndpointError(
      config.provider,
      null,
      `no base URL configured — set credentials.${config.provider}.endpoint in llm.yaml`,
    )
  }
  const checked = checkLlmBaseUrl(raw)
  if (!checked.ok) {
    throw new LlmEndpointError(config.provider, endpointSecret, checked.reason)
  }
  return checked.url
}

// Re-exports kept so existing imports of LlmProviderError from this module
// still work (some callers grab both the factory + the error type).
export { LlmProviderError }
