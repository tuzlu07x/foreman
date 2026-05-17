import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { checkSecretSlotDuplicates } from '../../src/core/doctor.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { closeDb, getDb } from '../../src/db/client.js'
import { loadOrCreateSecretsMasterKey } from '../../src/identity/master-key.js'

// =============================================================================
// Tests for #342 — doctor surfaces legacy duplicate slots
// =============================================================================

describe('checkSecretSlotDuplicates', () => {
  let tmp: string
  let previousHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-doctor-slots-'))
    previousHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmp
  })

  afterEach(() => {
    closeDb()
    if (previousHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = previousHome
    rmSync(tmp, { recursive: true, force: true })
  })

  it('ok when vault has no provider slots at all', () => {
    runInit()
    const r = checkSecretSlotDuplicates()
    expect(r.status).toBe('ok')
    expect(r.message).toMatch(/no legacy/)
  })

  it('ok when only canonical slots exist (fresh post-#291 vault)', () => {
    runInit()
    const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'sk-ant-ok')
    store.add('openai-key', 'sk-proj-ok')
    const r = checkSecretSlotDuplicates()
    expect(r.status).toBe('ok')
  })

  it('warn when both canonical + legacy slot exist for the same provider', () => {
    runInit()
    const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'sk-ant-new')
    store.add('anthropic-api-key', 'sk-ant-legacy')
    const r = checkSecretSlotDuplicates()
    expect(r.status).toBe('warn')
    expect(r.message).toMatch(/anthropic-api-key/)
    expect(r.remediation).toMatch(/foreman secrets dedupe-providers/)
  })

  it('warn lists every duplicate when multiple providers affected', () => {
    runInit()
    const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'a')
    store.add('anthropic-api-key', 'a-legacy')
    store.add('openai-key', 'b')
    store.add('openai-api-key', 'b-legacy')
    const r = checkSecretSlotDuplicates()
    expect(r.status).toBe('warn')
    expect(r.message).toMatch(/2 legacy/)
    expect(r.message).toMatch(/anthropic-api-key/)
    expect(r.message).toMatch(/openai-api-key/)
  })
})
