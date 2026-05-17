import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { closeDb, getDb } from '../../src/db/client.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { loadOrCreateSecretsMasterKey } from '../../src/identity/master-key.js'

// =============================================================================
// Regression for #258 — `secrets rotate` must NOT fan out to agents the user
// hasn't installed. We test this at the SecretStore level by driving rotate
// + agent-add and asserting that only the registered agent's config file
// gets touched.
//
// We intentionally don't import the CLI subcommand handler (would need to
// stub commander); instead we recreate the same code path with an isolated
// db + tmp HOME and confirm projection touches only registered agents.
// =============================================================================

import { RegistryService } from '../../src/core/registry.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { loadActiveRegistry } from '../../src/core/registry-catalog.js'
import { projectSecretsForAgent } from '../../src/core/agent-secrets-projector.js'

function fanoutSimulation(
  secretName: string,
  store: SecretStore,
  db: import('../../src/db/client.js').ForemanDb,
  home: string,
): string[] {
  // Mirror of the production `fanoutRotation` in src/cli/secrets-cli.ts —
  // updated #258 to intersect doc.agents with registry.listAll().
  const { doc } = loadActiveRegistry()
  const registry = new RegistryService(db, new EventBus<ForemanEventMap>())
  const installed = registry.listAll()
  const installedCatalogIds = new Set<string>()
  for (const a of installed) {
    const ref = a.metadata?.registryId
    if (typeof ref === 'string') installedCatalogIds.add(ref)
  }
  const touched: string[] = []
  for (const entry of doc.agents) {
    if (!entry.secret_projection) continue
    if (!installedCatalogIds.has(entry.id)) continue
    const result = projectSecretsForAgent(entry, {
      providersSelected: ['anthropic'],
      servicesSelected: [],
      secretStore: store,
      home,
    })
    for (const f of result.files) {
      if (f.secrets.includes(secretName)) touched.push(entry.id)
    }
  }
  return touched
}

describe('secrets rotate — fanout filtered to installed agents (#258)', () => {
  let tmp: string
  let fakeHome: string
  let prevForeman: string | undefined
  let prevHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-fanout-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-fanout-home-'))
    prevForeman = process.env.FOREMAN_HOME
    prevHome = process.env.HOME
    process.env.FOREMAN_HOME = tmp
    process.env.HOME = fakeHome
    runInit()
  })

  afterEach(() => {
    closeDb()
    if (prevForeman === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = prevForeman
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(tmp, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('with NO agents registered, rotation touches zero config files (#258)', () => {
    const db = getDb()
    const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'sk-ant-FIRST')
    store.rotate('anthropic-key', 'sk-ant-SECOND')
    const touched = fanoutSimulation('anthropic-key', store, db, fakeHome)
    expect(touched).toEqual([])
  })

  it('with only hermes registered, rotation touches hermes and nothing else', () => {
    const db = getDb()
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>())
    registry.register({
      id: 'my-hermes',
      displayName: 'Hermes',
      transport: 'stdio',
      metadata: { registryId: 'hermes' },
    })

    const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'sk-ant-FIRST')
    const touched = fanoutSimulation('anthropic-key', store, db, fakeHome)
    expect(touched).toEqual(['hermes'])
  })

  it('with hermes + claude-code both registered, both get the new value', () => {
    const db = getDb()
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>())
    registry.register({
      id: 'h',
      displayName: 'Hermes',
      transport: 'stdio',
      metadata: { registryId: 'hermes' },
    })
    registry.register({
      id: 'cc',
      displayName: 'Claude Code',
      transport: 'stdio',
      metadata: { registryId: 'claude-code' },
    })

    const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'sk-ant-NEW')
    const touched = fanoutSimulation('anthropic-key', store, db, fakeHome)
    expect(touched.sort()).toEqual(['claude-code', 'hermes'])

    // Spot-check that the projected files actually contain the new value.
    const hermesEnv = readFileSync(`${fakeHome}/.hermes/.env`, 'utf-8')
    expect(hermesEnv).toContain('ANTHROPIC_API_KEY=sk-ant-NEW')
    const claudeSettings = JSON.parse(
      readFileSync(`${fakeHome}/.claude/settings.json`, 'utf-8'),
    )
    expect(claudeSettings.env.ANTHROPIC_API_KEY).toBe('sk-ant-NEW')
  })
})
