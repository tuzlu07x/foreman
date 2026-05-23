import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { checkLlmCredentials } from '../../src/core/doctor.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { closeDb, getDb } from '../../src/db/client.js'
import { loadOrCreateSecretsMasterKey } from '../../src/identity/master-key.js'

// Regression for Bug B (queued during QA-008) — when the user opts into LLM
// (`enabled: true` in llm.yaml) but never adds the provider's API key to the
// secret store, verification + smart-report silently fall back to heuristic-
// only forever. doctor must surface this as a `warn` so the user notices.

describe('checkLlmCredentials', () => {
  let tmp: string
  let previousHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-doctor-creds-'))
    previousHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmp
  })

  afterEach(() => {
    closeDb()
    if (previousHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = previousHome
    rmSync(tmp, { recursive: true, force: true })
  })

  it('ok when llm.yaml is absent', () => {
    runInit()
    const r = checkLlmCredentials()
    expect(r.status).toBe('ok')
    expect(r.message).toContain('absent')
  })

  it('ok when LLM global switch is off (regardless of creds)', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      'enabled: false\nprovider: anthropic\nmodel: m\n',
      'utf-8',
    )
    const r = checkLlmCredentials()
    expect(r.status).toBe('ok')
    expect(r.message).toMatch(/global switch is off/)
  })

  it('warn when LLM enabled but provider.secret_name is unset in llm.yaml', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: anthropic
model: m
credentials:
  anthropic:
    secret_name: null
`,
      'utf-8',
    )
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toMatch(/secret_name is unset/)
    expect(r.remediation).toContain('llm.yaml')
  })

  it('warn when secret_name references a missing secret', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: anthropic
model: m
credentials:
  anthropic:
    secret_name: anthropic-key
`,
      'utf-8',
    )
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toMatch(/secret "anthropic-key" is missing/)
    expect(r.remediation).toContain('foreman secrets add anthropic-key')
  })

  it('ok when LLM enabled and the secret is present', () => {
    runInit()
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: anthropic
model: m
credentials:
  anthropic:
    secret_name: anthropic-key
`,
      'utf-8',
    )
    const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'sk-ant-real')
    const r = checkLlmCredentials()
    expect(r.status).toBe('ok')
    expect(r.message).toContain('credentials present')
  })

  // #307 — prefix sanity check catches the round 2 footgun (OpenAI key
  // pasted into Anthropic slot). Provider catalog supplies the expected
  // prefix; mismatch surfaces as warn with a "rotate" hint.
  describe('prefix sanity check', () => {
    function writeLlmYaml(provider: 'anthropic' | 'openai' | 'gemini') {
      const secretName = `${provider}-key`
      writeFileSync(
        join(tmp, 'llm.yaml'),
        `enabled: true
provider: ${provider}
model: m
credentials:
  ${provider}:
    secret_name: ${secretName}
`,
        'utf-8',
      )
      return secretName
    }

    it('warns when an OpenAI sk-proj- key sits in the Anthropic slot', () => {
      runInit()
      const secretName = writeLlmYaml('anthropic')
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add(secretName, 'sk-proj-actually-an-openai-key')
      const r = checkLlmCredentials()
      expect(r.status).toBe('warn')
      expect(r.message).toMatch(/doesn't match anthropic key format/)
      expect(r.message).toContain('sk-ant-')
      expect(r.remediation).toContain('foreman secrets rotate anthropic-key')
    })

    it('warns when an Anthropic sk-ant- key sits in the OpenAI slot', () => {
      runInit()
      const secretName = writeLlmYaml('openai')
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add(secretName, 'sk-ant-actually-an-anthropic-key')
      const r = checkLlmCredentials()
      expect(r.status).toBe('warn')
      expect(r.message).toMatch(/doesn't match openai key format/)
    })

    it('ok when an OpenAI sk-proj- key sits in the OpenAI slot (prefix sk-)', () => {
      runInit()
      const secretName = writeLlmYaml('openai')
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add(secretName, 'sk-proj-real-openai-key')
      const r = checkLlmCredentials()
      expect(r.status).toBe('ok')
    })

    it('ok when a Gemini AIza key sits in the Gemini slot', () => {
      runInit()
      const secretName = writeLlmYaml('gemini')
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add(secretName, 'AIzaSyDfoobar')
      const r = checkLlmCredentials()
      expect(r.status).toBe('ok')
    })

    it('warns when a random string sits in any slot (catches unset / placeholder values)', () => {
      runInit()
      const secretName = writeLlmYaml('anthropic')
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add(secretName, 'placeholder-paste-the-real-key-here')
      const r = checkLlmCredentials()
      expect(r.status).toBe('warn')
      expect(r.message).toMatch(/doesn't match anthropic key format/)
    })
  })

  // ---------- Faz 5 / #508 — OAuth (`auth_mode: oauth`) checks ----------

  describe('OAuth credentials', () => {
    function writeOAuthYaml(provider: 'anthropic' | 'openai' | 'gemini'): void {
      writeFileSync(
        join(tmp, 'llm.yaml'),
        `enabled: true
provider: ${provider}
model: m
credentials:
  ${provider}:
    auth_mode: oauth
`,
        'utf-8',
      )
    }

    it('warn when auth_mode: oauth but no tokens are stored', () => {
      runInit()
      writeOAuthYaml('anthropic')
      const r = checkLlmCredentials()
      expect(r.status).toBe('warn')
      expect(r.message).toMatch(/anthropic.*OAuth.*no tokens/)
      expect(r.remediation).toContain('foreman llm login anthropic')
    })

    it('ok when auth_mode: oauth and tokens are present (Anthropic, no accountId)', () => {
      runInit()
      writeOAuthYaml('anthropic')
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add(
        'llm-oauth-anthropic',
        JSON.stringify({
          accessToken: 'sk-ant-oat01-x',
          refreshToken: 'rt',
          expiresAt: Date.now() + 60 * 60_000,
        }),
      )
      const r = checkLlmCredentials()
      expect(r.status).toBe('ok')
      expect(r.message).toMatch(/anthropic OAuth tokens present/)
      // No accountId for Anthropic → no "(account ...)" suffix.
      expect(r.message).not.toContain('account ')
    })

    it('ok when auth_mode: oauth and tokens are present (Codex, with accountId)', () => {
      runInit()
      writeOAuthYaml('openai')
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add(
        'llm-oauth-openai',
        JSON.stringify({
          accessToken: 'A',
          refreshToken: 'R',
          expiresAt: Date.now() + 60 * 60_000,
          accountId: 'acc-42',
        }),
      )
      const r = checkLlmCredentials()
      expect(r.status).toBe('ok')
      expect(r.message).toMatch(/openai OAuth tokens present \(account acc-42\)/)
    })

    it('warn when a non-OAuth provider (gemini) is configured with auth_mode: oauth', () => {
      // Factory silently falls back to api-key for gemini; doctor flags
      // it so the user notices their config does nothing.
      runInit()
      writeOAuthYaml('gemini')
      const r = checkLlmCredentials()
      expect(r.status).toBe('warn')
      expect(r.message).toMatch(/Foreman only supports OAuth for anthropic \+ openai/)
      expect(r.remediation).toContain('api_key')
    })

    it('does not regress when auth_mode is api_key (explicit) — uses the existing path', () => {
      runInit()
      writeFileSync(
        join(tmp, 'llm.yaml'),
        `enabled: true
provider: anthropic
model: m
credentials:
  anthropic:
    auth_mode: api_key
    secret_name: anthropic-key
`,
        'utf-8',
      )
      const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
      store.add('anthropic-key', 'sk-ant-real')
      const r = checkLlmCredentials()
      expect(r.status).toBe('ok')
      expect(r.message).toMatch(/anthropic credentials present/)
    })
  })
})
