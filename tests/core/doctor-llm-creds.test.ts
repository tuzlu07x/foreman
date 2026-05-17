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
})
