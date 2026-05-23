import type Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  describeAuthMode,
  performOAuthLogin,
  performOAuthLogout,
  setAuthMode,
  type LoginDeps,
} from '../../src/cli/llm-cli.js'
import {
  defaultLlmConfig,
  LlmConfigSchema,
  saveLlmConfig,
  type LlmConfig,
} from '../../src/core/llm/config.js'
import {
  getOAuthProvider,
  type OAuthProviderId,
} from '../../src/core/llm/oauth/oauth-providers.js'
import {
  loadOAuthTokens,
  saveOAuthTokens,
} from '../../src/core/llm/oauth/token-store.js'
import type { OAuthTokens } from '../../src/core/llm/oauth/oauth-flow.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { generateMasterKey } from '../../src/identity/encryption.js'

// =============================================================================
// Faz 4 / #507 — `foreman llm login` / `logout` action cores
//
// Tests the testable helpers, not the commander glue: they cover the actual
// state transitions (tokens persisted, llm.yaml flipped, deps wired through).
// =============================================================================

describe('setAuthMode', () => {
  it('flips auth_mode while preserving secret_name + other fields', () => {
    const config = LlmConfigSchema.parse({
      credentials: {
        anthropic: { secret_name: 'anthropic-key', auth_mode: 'api_key' },
      },
    })
    const updated = setAuthMode(config, 'anthropic', 'oauth')
    expect(updated.credentials.anthropic?.auth_mode).toBe('oauth')
    // secret_name preserved — user might switch modes back later.
    expect(updated.credentials.anthropic?.secret_name).toBe('anthropic-key')
  })

  it('creates the credential block when absent', () => {
    const config = LlmConfigSchema.parse({})
    const updated = setAuthMode(config, 'openai', 'oauth')
    expect(updated.credentials.openai?.auth_mode).toBe('oauth')
  })

  it('does not mutate the input config', () => {
    const config = LlmConfigSchema.parse({
      credentials: { anthropic: { auth_mode: 'api_key' } },
    })
    setAuthMode(config, 'anthropic', 'oauth')
    expect(config.credentials.anthropic?.auth_mode).toBe('api_key')
  })
})

describe('describeAuthMode', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let store: SecretStore

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    store = new SecretStore(db, generateMasterKey())
    void db
  })
  afterEach(() => {
    sqlite.close()
  })

  it('renders "api key (<name>)" for api-key mode with a secret_name', () => {
    const config = LlmConfigSchema.parse({
      credentials: {
        anthropic: { auth_mode: 'api_key', secret_name: 'anthropic-key' },
      },
    })
    expect(describeAuthMode(config, store, 'anthropic')).toContain(
      'anthropic-key',
    )
    expect(describeAuthMode(config, store, 'anthropic')).toContain('api key')
  })

  it('renders "OAuth (signed in, account ...)" when tokens are stored', () => {
    const config = LlmConfigSchema.parse({
      credentials: { openai: { auth_mode: 'oauth' } },
    })
    saveOAuthTokens(store, 'openai', {
      accessToken: 'A',
      refreshToken: 'R',
      expiresAt: Date.now() + 60_000,
      accountId: 'acc-42',
    })
    const out = describeAuthMode(config, store, 'openai')
    expect(out).toContain('OAuth')
    expect(out).toContain('signed in')
    expect(out).toContain('acc-42')
  })

  it('warns "(not signed in)" when auth_mode is oauth but no tokens stored', () => {
    const config = LlmConfigSchema.parse({
      credentials: { anthropic: { auth_mode: 'oauth' } },
    })
    const out = describeAuthMode(config, store, 'anthropic')
    expect(out).toContain('not signed in')
    expect(out).toContain('foreman llm login anthropic')
  })

  it('omits "account" suffix when the bundle has no accountId (Anthropic)', () => {
    const config = LlmConfigSchema.parse({
      credentials: { anthropic: { auth_mode: 'oauth' } },
    })
    saveOAuthTokens(store, 'anthropic', {
      accessToken: 'A',
      refreshToken: 'R',
      expiresAt: Date.now() + 60_000,
    })
    const out = describeAuthMode(config, store, 'anthropic')
    expect(out).toContain('signed in')
    expect(out).not.toContain('account')
  })
})

describe('performOAuthLogin', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let store: SecretStore
  let tmpDir: string
  let llmConfigPath: string

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    store = new SecretStore(db, generateMasterKey())
    void db
    tmpDir = mkdtempSync(join(tmpdir(), 'llm-login-'))
    llmConfigPath = join(tmpDir, 'llm.yaml')
    saveLlmConfig(llmConfigPath, defaultLlmConfig())
  })
  afterEach(() => {
    sqlite.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  type LoginIO = Parameters<LoginDeps['runLogin']>[1]
  type FakeDeps = LoginDeps & {
    readonly runLoginCalls: number
    readonly lastLoginIO: LoginIO | null
  }
  function fakeDeps(tokens: OAuthTokens): FakeDeps {
    const state: { runLoginCalls: number; lastLoginIO: LoginIO | null } = {
      runLoginCalls: 0,
      lastLoginIO: null,
    }
    return {
      runLogin: async (_provider, io) => {
        state.runLoginCalls++
        state.lastLoginIO = io
        return tokens
      },
      openInBrowser: vi.fn(),
      promptPaste: async () => 'PASTED',
      get runLoginCalls() {
        return state.runLoginCalls
      },
      get lastLoginIO() {
        return state.lastLoginIO
      },
    }
  }

  it('persists tokens + flips auth_mode to oauth in llm.yaml (Codex)', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'sk-codex-tok',
      refreshToken: 'sk-codex-refresh',
      expiresAt: Date.now() + 60 * 60_000,
      accountId: 'acc-99',
    }
    const deps = fakeDeps(tokens)
    const provider = getOAuthProvider('openai')

    const result = await performOAuthLogin(
      provider,
      { headless: false },
      { llmConfigPath },
      store,
      deps,
    )

    expect(result).toEqual({ accountId: 'acc-99' })
    expect(loadOAuthTokens(store, 'openai')).toEqual(tokens)

    const yaml = parseYaml(readFileSync(llmConfigPath, 'utf-8')) as LlmConfig
    expect(yaml.credentials.openai?.auth_mode).toBe('oauth')
  })

  it('passes useLoopback=true when not headless and skips readPastedCode', async () => {
    const deps = fakeDeps({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
    })
    await performOAuthLogin(
      getOAuthProvider('anthropic'),
      { headless: false },
      { llmConfigPath },
      store,
      deps,
    )
    const io = deps.lastLoginIO!
    expect(io.useLoopback).toBe(true)
    expect(io.readPastedCode).toBeUndefined()
  })

  it('passes useLoopback=false + readPastedCode in headless mode', async () => {
    const deps = fakeDeps({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
    })
    await performOAuthLogin(
      getOAuthProvider('anthropic'),
      { headless: true },
      { llmConfigPath },
      store,
      deps,
    )
    const io = deps.lastLoginIO!
    expect(io.useLoopback).toBe(false)
    expect(typeof io.readPastedCode).toBe('function')
  })

  it('omits accountId from the result when the token bundle has none (Anthropic)', async () => {
    const deps = fakeDeps({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
    })
    const result = await performOAuthLogin(
      getOAuthProvider('anthropic'),
      { headless: false },
      { llmConfigPath },
      store,
      deps,
    )
    expect(result).toEqual({})
  })

  it('lets runLogin errors propagate (does not write tokens or touch llm.yaml)', async () => {
    const deps: LoginDeps = {
      runLogin: async () => {
        throw new Error('auth failed')
      },
      openInBrowser: vi.fn(),
      promptPaste: async () => 'x',
    }
    await expect(
      performOAuthLogin(
        getOAuthProvider('openai'),
        { headless: false },
        { llmConfigPath },
        store,
        deps,
      ),
    ).rejects.toThrow(/auth failed/)
    expect(loadOAuthTokens(store, 'openai')).toBeNull()
    const yaml = parseYaml(readFileSync(llmConfigPath, 'utf-8')) as LlmConfig
    expect(yaml.credentials.openai?.auth_mode ?? 'api_key').toBe('api_key')
  })
})

describe('performOAuthLogout', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let store: SecretStore
  let tmpDir: string
  let llmConfigPath: string

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    store = new SecretStore(db, generateMasterKey())
    void db
    tmpDir = mkdtempSync(join(tmpdir(), 'llm-logout-'))
    llmConfigPath = join(tmpDir, 'llm.yaml')
    const cfg = setAuthMode(defaultLlmConfig(), 'openai', 'oauth')
    saveLlmConfig(llmConfigPath, cfg)
    saveOAuthTokens(store, 'openai', {
      accessToken: 'A',
      refreshToken: 'R',
      expiresAt: Date.now() + 60_000,
      accountId: 'acc-1',
    })
  })
  afterEach(() => {
    sqlite.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('clears tokens and reverts auth_mode to api_key', () => {
    performOAuthLogout('openai', { llmConfigPath }, store)
    expect(loadOAuthTokens(store, 'openai')).toBeNull()
    const yaml = parseYaml(readFileSync(llmConfigPath, 'utf-8')) as LlmConfig
    expect(yaml.credentials.openai?.auth_mode).toBe('api_key')
  })

  it('is idempotent — no throw when tokens are already gone', () => {
    performOAuthLogout('openai', { llmConfigPath }, store)
    expect(() =>
      performOAuthLogout('openai', { llmConfigPath }, store),
    ).not.toThrow()
  })

  it('only touches the requested provider — leaves others untouched', () => {
    saveOAuthTokens(store, 'anthropic', {
      accessToken: 'A2',
      refreshToken: 'R2',
      expiresAt: Date.now() + 60_000,
    })
    const otherProvider: OAuthProviderId = 'openai'
    performOAuthLogout(otherProvider, { llmConfigPath }, store)
    expect(loadOAuthTokens(store, 'anthropic')).not.toBeNull()
  })
})
