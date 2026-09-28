import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasForemanHook } from '../../src/core/agent-hook.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { runInstallStep } from '../../src/tui/setup-wizard.js'
import { stubInstallers } from '../support/stub-installers.js'

// Terminal QA: Claude Code's PreToolUse hook (its own Bash / Edit / Read
// checked before they run) was a separate step nobody took. The wizard
// now asks, yes by default, and the install step adds the hook.
describe('install step: Claude Code PreToolUse hook', () => {
  let dir: string
  let db: ForemanDb
  let sqlite: Database.Database
  let saved: { HOME?: string; PATH?: string }
  let logs: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-claude-hook-'))
    saved = { HOME: process.env.HOME, PATH: process.env.PATH }
    const stubs = stubInstallers(dir)
    // A stand-in `claude` so nothing tries to install the real one.
    const claude = join(dir, 'stub-bin', 'claude')
    writeFileSync(claude, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n')
    chmodSync(claude, 0o755)
    process.env.PATH = stubs.path
    process.env.HOME = join(dir, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    logs = []
  })

  afterEach(() => {
    sqlite.close()
    process.env.HOME = saved.HOME
    process.env.PATH = saved.PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const services = () => ({
    db,
    secretStore: new SecretStore(db, Buffer.alloc(32, 7)),
    registry: new RegistryService(db, new EventBus<ForemanEventMap>()),
    policyPath: join(dir, 'policy.yaml'),
    llmConfigPath: join(dir, 'llm.yaml'),
    notifyConfigPath: join(dir, 'notify.yaml'),
    voiceConfigPath: join(dir, 'voice.yaml'),
    launchEditor: vi.fn().mockResolvedValue(undefined) as () => Promise<unknown>,
  })
  const settingsPath = () => join(process.env.HOME!, '.claude', 'settings.json')

  it('adds the hook by default', async () => {
    await runInstallStep(['claude-code'], [], services(), (l) => logs.push(l))
    expect(existsSync(settingsPath())).toBe(true)
    expect(hasForemanHook(JSON.parse(readFileSync(settingsPath(), 'utf-8')), 'claude-code')).toBe(true)
    expect(logs.some((l) => l.includes('PreToolUse hook added'))).toBe(true)
  })

  it('leaves it out when the user said no', async () => {
    await runInstallStep(['claude-code'], [], services(), (l) => logs.push(l), {
      'claude-code': { preToolUseHook: false },
    })
    const settings = existsSync(settingsPath()) ? JSON.parse(readFileSync(settingsPath(), 'utf-8')) : {}
    expect(hasForemanHook(settings, 'claude-code')).toBe(false)
  })

  it('keeps an existing settings file and its other hooks', async () => {
    mkdirSync(join(process.env.HOME!, '.claude'), { recursive: true })
    const mine = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-check' }] }] } }
    writeFileSync(settingsPath(), JSON.stringify(mine))
    await runInstallStep(['claude-code'], [], services(), (l) => logs.push(l))
    const after = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
    expect(after.theme).toBe('dark')
    expect(JSON.stringify(after)).toContain('my-own-check')
    expect(hasForemanHook(after, 'claude-code')).toBe(true)
  })
})
