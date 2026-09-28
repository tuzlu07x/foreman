import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveOAuthTokens } from '../../src/core/llm/oauth/token-store.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import {
  brainPickerChoices,
  brainPickerCursor,
  resolveBrainModelSource,
} from '../../src/tui/setup-wizard/foreman-llm-logic.js'

// =============================================================================
// Foreman's-brain picker for subscription-only users (#575 follow-up).
// The rows the key handler can land on must be the rows the render enables,
// and model discovery must accept the same credentials the picker counts.
// All tokens and keys below are fakes.
// =============================================================================

describe('brainPickerChoices / brainPickerCursor', () => {
  it('lets the cursor land on a provider enabled only by a sign-in', () => {
    const choices = brainPickerChoices(new Set(['anthropic']))
    expect(choices).toEqual(['anthropic', 'ollama', 'preset', 'skip'])
    expect(brainPickerCursor(null, choices)).toBe('anthropic')
  })

  it('ignores a draft that is no longer selectable', () => {
    const choices = brainPickerChoices(new Set(['openai']))
    expect(brainPickerCursor('anthropic', choices)).toBe('openai')
    expect(brainPickerCursor('gemini', choices)).toBe('openai')
    expect(brainPickerCursor('preset', choices)).toBe('preset')
    expect(brainPickerCursor('skip', choices)).toBe('skip')
  })

  it('always offers Ollama and OpenAI-compatible, even with no cloud provider', () => {
    expect(brainPickerChoices(new Set())).toEqual(['ollama', 'preset', 'skip'])
  })
})

describe('resolveBrainModelSource', () => {
  let sqlite: Database.Database
  let store: SecretStore

  beforeEach(() => {
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, Buffer.alloc(32, 7))
  })
  afterEach(() => {
    sqlite.close()
  })

  const farFuture = Date.now() + 24 * 60 * 60 * 1000

  it('explains a sign-in that only happens after the wizard instead of "No anthropic-key"', () => {
    const source = resolveBrainModelSource('anthropic', store, ['anthropic'])
    expect(source.kind).toBe('no-listing')
    if (source.kind !== 'no-listing') return
    expect(source.message).toContain('Claude subscription')
    expect(source.message).toContain('foreman llm login anthropic')
    expect(source.message).toContain('claude-haiku-4-5')
    expect(source.message).not.toContain('No anthropic-key')
  })

  it('uses an API key when one is stored', () => {
    store.add('openai-key', 'sk-fake-openai-000')
    const source = resolveBrainModelSource('openai', store, [])
    expect(source).toEqual({ kind: 'api-key', apiKey: 'sk-fake-openai-000' })
  })

  it('lists Anthropic models with stored Claude sign-in tokens', async () => {
    saveOAuthTokens(store, 'anthropic', {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      expiresAt: farFuture,
    })
    const source = resolveBrainModelSource('anthropic', store, [])
    expect(source.kind).toBe('oauth')
    if (source.kind !== 'oauth') return
    await expect(source.accessToken()).resolves.toBe('fake-access-token')
  })

  it('says a ChatGPT sign-in has no model list', () => {
    saveOAuthTokens(store, 'openai', {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      expiresAt: farFuture,
    })
    const source = resolveBrainModelSource('openai', store, [])
    expect(source.kind).toBe('no-listing')
    if (source.kind !== 'no-listing') return
    expect(source.message).toContain('ChatGPT sign-in')
  })

  it('names both options when nothing is configured', () => {
    const anthropic = resolveBrainModelSource('anthropic', store, [])
    expect(anthropic).toMatchObject({ kind: 'missing' })
    if (anthropic.kind === 'missing') {
      expect(anthropic.message).toContain('Claude sign-in')
    }
    const gemini = resolveBrainModelSource('gemini', store, [])
    expect(gemini).toMatchObject({ kind: 'missing' })
    if (gemini.kind === 'missing') {
      expect(gemini.message).toContain('No gemini-key')
    }
  })
})
