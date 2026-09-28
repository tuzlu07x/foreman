import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foremanInstallRecord } from '../../src/core/agent-add-flow.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { runInstallStep } from '../../src/tui/setup-wizard.js'
import { stubInstallers, type StubInstallers } from '../support/stub-installers.js'

// QA #657 H5 — unticking an agent in the wizard ran `npm uninstall -g`
// on it, whoever had installed it. It now only unregisters, unless the
// user chose (on the confirm screen) to uninstall what Foreman installed.
describe('wizard: unticked agents keep their binary', () => {
  let dir: string
  let db: ForemanDb
  let sqlite: Database.Database
  let registry: RegistryService
  let secretStore: SecretStore
  let stubs: StubInstallers
  let logs: string[]

  const services = () => ({
    db,
    secretStore,
    registry,
    policyPath: join(dir, 'policy.yaml'),
    llmConfigPath: join(dir, 'llm.yaml'),
    notifyConfigPath: join(dir, 'notify.yaml'),
    voiceConfigPath: join(dir, 'voice.yaml'),
    launchEditor: vi.fn().mockResolvedValue(undefined) as () => Promise<unknown>,
  })
  const uninstalls = () => stubs.calls().filter((c) => c.includes('uninstall'))
  const registerClaude = (metadata: Record<string, unknown> = {}) =>
    registry.register({
      id: 'claude-code',
      displayName: 'Claude Code',
      transport: 'stdio',
      metadata: { registryId: 'claude-code', ...metadata },
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-wizard-remove-'))
    stubs = stubInstallers(dir, { exitCode: 0 })
    vi.stubEnv('PATH', stubs.path)
    vi.stubEnv('HOME', join(dir, 'home'))
    ;({ db, sqlite } = createInMemoryDb())
    registry = new RegistryService(db, new EventBus<ForemanEventMap>())
    secretStore = new SecretStore(db, Buffer.alloc(32, 7))
    logs = []
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('unregisters without uninstalling by default', async () => {
    registerClaude()
    const summary = await runInstallStep([], ['claude-code'], services(), (l) => logs.push(l))
    expect(summary.removed).toEqual(['claude-code'])
    expect(registry.get('claude-code')).toBeNull()
    expect(uninstalls()).toEqual([])
    expect(logs.join('\n')).toContain('Claude Code left installed')
  })

  it('never uninstalls a binary Foreman did not install, even when asked', async () => {
    registerClaude()
    await runInstallStep([], ['claude-code'], services(), (l) => logs.push(l), {}, undefined, undefined, { uninstall: true })
    expect(uninstalls()).toEqual([])
    expect(logs.join('\n')).toContain("left installed (Foreman didn't install it)")
  })

  it('uninstalls what Foreman installed when the user chose to', async () => {
    registerClaude({ installedByForeman: { command: 'npm install -g @anthropic-ai/claude-code', at: 1 } })
    await runInstallStep([], ['claude-code'], services(), (l) => logs.push(l), {}, undefined, undefined, { uninstall: true })
    expect(uninstalls()).toEqual(['npm uninstall -g @anthropic-ai/claude-code'])
  })

  it('records an install Foreman ran, so it may be uninstalled later', async () => {
    await runInstallStep(['claude-code'], [], services(), (l) => logs.push(l))
    expect(stubs.calls()).toContain('npm install -g @anthropic-ai/claude-code')
    expect(foremanInstallRecord(registry.get('claude-code')?.metadata)?.command).toBe(
      'npm install -g @anthropic-ai/claude-code',
    )
  })
})
