import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ControlChannel, type OwnerStore } from '../../../src/core/control-channel.js'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { ForemanCommandRouter, registerBuiltinCommands } from '../../../src/core/foreman-command.js'
import { cliDelegationSource, orgDelegationVerdict } from '../../../src/core/org/guard.js'
import { findOrgTemplate } from '../../../src/core/org/templates.js'
import { RegistryService } from '../../../src/core/registry.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'

describe('org delegation guard', () => {
  let dir: string
  let orgPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-org-guard-'))
    orgPath = join(dir, 'org.yaml')
    writeFileSync(orgPath, findOrgTemplate('startup')!.render('Acme'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('never blocks the human or when there is no org chart', () => {
    expect(orgDelegationVerdict(orgPath, 'cli', 'openclaw')).toBeNull()
    expect(orgDelegationVerdict(join(dir, 'missing.yaml'), 'codex', 'openclaw')).toBeNull()
  })

  it('blocks an engineer handing marketing work across departments', () => {
    expect(orgDelegationVerdict(orgPath, 'codex', 'openclaw')).toMatchObject({ allowed: false })
    expect(orgDelegationVerdict(orgPath, 'claude-code', 'codex')).toMatchObject({ allowed: true })
  })

  it('fails closed when org.yaml is broken', () => {
    writeFileSync(orgPath, 'version: 1\ncompany: X\nroles: {}\n')
    expect(orgDelegationVerdict(orgPath, 'codex', 'openclaw')).toMatchObject({ allowed: false })
  })

  it('treats a Foreman-spawned shell as its agent, otherwise as the human', () => {
    expect(cliDelegationSource({ FOREMAN_SPAWNED_BY: 'codex' })).toBe('codex')
    expect(cliDelegationSource({})).toBe('cli')
  })
})

describe('`/foreman write` honours the org chart', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  const owner: OwnerStore = {
    exists: (n) => n === 'telegram-chat-id',
    get: () => '42',
  }

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    dir = mkdtempSync(join(tmpdir(), 'foreman-org-write-'))
    writeFileSync(join(dir, 'org.yaml'), findOrgTemplate('startup')!.render('Acme'))
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>())
    for (const id of ['codex', 'openclaw', 'claude-code']) {
      registry.register({ id, displayName: id, transport: 'stdio' })
    }
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function write(sourceAgent: string, target: string) {
    const router = new ForemanCommandRouter()
    registerBuiltinCommands(router)
    const channel = new ControlChannel(db)
    const result = await router.dispatch('write', [target, 'do', 'it'], {
      db,
      registry: new RegistryService(db, new EventBus<ForemanEventMap>()),
      llmConfigPath: join(dir, 'llm.yaml'),
      configDir: dir,
      sourceAgent,
      sourceUser: '42',
      controlChannel: channel,
      ownerStore: owner,
    })
    return { result, queued: channel.pending().length }
  }

  it('refuses a delegation outside the reporting chain and queues nothing', async () => {
    const { result, queued } = await write('codex', 'openclaw')
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('ORG_POLICY')
    expect(result.text).toMatch(/department heads/)
    expect(queued).toBe(0)
  })

  it('lets a manager assign to a direct report', async () => {
    const { result, queued } = await write('claude-code', 'codex')
    expect(result.ok).toBe(true)
    expect(queued).toBe(1)
  })
})
