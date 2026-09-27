import { describe, expect, it } from 'vitest'
import { LlmConfigSchema, ProviderIdSchema } from '../../../src/core/llm/config.js'
import {
  buildLlmClient,
  hasRuntimeClient,
  LlmProviderUnavailableError,
} from '../../../src/core/llm/factory.js'
import { SecretNotFoundError } from '../../../src/core/secret-store.js'

// =============================================================================
// hasRuntimeClient is what the setup wizard's brain picker reads to decide
// which brains it can offer. It must agree with buildLlmClient for every
// provider the schema accepts, or the picker drifts from what actually runs.
// =============================================================================

const emptyStore = {
  get(name: string): string {
    throw new SecretNotFoundError(name)
  },
}

function unavailable(provider: (typeof ProviderIdSchema.options)[number]): boolean {
  const config = LlmConfigSchema.parse({ provider, credentials: {} })
  try {
    buildLlmClient(config, emptyStore as never)
    return false
  } catch (err) {
    return err instanceof LlmProviderUnavailableError
  }
}

describe('hasRuntimeClient', () => {
  it.each(ProviderIdSchema.options)('%s agrees with buildLlmClient', (provider) => {
    expect(hasRuntimeClient(provider)).toBe(!unavailable(provider))
  })

  it('reports Ollama and OpenAI-compatible as not built yet', () => {
    expect(hasRuntimeClient('ollama')).toBe(false)
    expect(hasRuntimeClient('openai_compatible')).toBe(false)
    expect(hasRuntimeClient('anthropic')).toBe(true)
  })
})
