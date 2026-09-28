import { describe, expect, it } from 'vitest'
import { LlmConfigSchema, ProviderIdSchema } from '../../../src/core/llm/config.js'
import {
  buildLlmClient,
  LlmProviderUnavailableError,
} from '../../../src/core/llm/factory.js'
import { SecretNotFoundError } from '../../../src/core/secret-store.js'

// =============================================================================
// Every provider the schema accepts has a runtime client: the setup wizard
// offers all of them as Foreman's brain, so none may fall through to
// LlmProviderUnavailableError. A missing credential is a different error.
// =============================================================================

const emptyStore = {
  get(name: string): string {
    throw new SecretNotFoundError(name)
  },
}

describe('buildLlmClient covers every provider', () => {
  it.each(ProviderIdSchema.options)('%s has a client', (provider) => {
    const config = LlmConfigSchema.parse({ provider, credentials: {} })
    let error: unknown = null
    try {
      buildLlmClient(config, emptyStore as never)
    } catch (err) {
      error = err
    }
    expect(error).not.toBeInstanceOf(LlmProviderUnavailableError)
  })
})
