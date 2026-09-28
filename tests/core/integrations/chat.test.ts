import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isIntegrationOwner } from '../../../src/cli/start.js'
import { ForemanCommandRouter, registerBuiltinCommands, relayedCommandAccess } from '../../../src/core/foreman-command.js'
import { clipForSurface, integrationChat, type IntegrationChatContext } from '../../../src/core/integrations/chat.js'
import { CONFIRMATION_TTL_MS, ConfirmationStore } from '../../../src/core/integrations/confirmations.js'
import { launchFingerprint } from '../../../src/core/integrations/status.js'
import { createIntegrationWiring, loadIntegrationCatalogs } from '../../../src/core/integrations/wiring.js'
import { loadHubConfig } from '../../../src/core/mcp-hub/config.js'
import { ToolPinStore } from '../../../src/core/mcp-hub/pins.js'
import { SecretStore } from '../../../src/core/secret-store.js'
import { createInMemoryDb } from '../../../src/db/client.js'

const PAT = `ghp_${'A'.repeat(36)}`
const catalogs = loadIntegrationCatalogs()

describe('ConfirmationStore', () => {
  const scope = { surface: 'slack', user: 'U1', action: 'remove', server: 'jira' }

  it('confirms once, for the same person and integration, within two minutes', () => {
    let now = 1_000
    const store = new ConfirmationStore(() => now)
    const code = store.issue(scope)
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    expect(store.consume(code, { ...scope, user: 'U2' })).toBe(false)
    // A mismatch burns it.
    expect(store.consume(code, scope)).toBe(false)
    const again = store.issue(scope)
    expect(store.consume(again.toLowerCase(), scope)).toBe(true)
    expect(store.consume(again, scope)).toBe(false)
    const late = store.issue(scope)
    now += CONFIRMATION_TTL_MS + 1
    expect(store.consume(late, scope)).toBe(false)
  })

  it('keeps one live code per scope', () => {
    const store = new ConfirmationStore()
    const first = store.issue(scope)
    const second = store.issue(scope)
    expect(store.consume(first, scope)).toBe(false)
    expect(store.consume(second, scope)).toBe(true)
  })
})

describe('integrationChat', () => {
  let dir: string
  let sqlite: Database.Database
  let store: SecretStore
  let notices: string[]
  let ctx: IntegrationChatContext
  let pins: ToolPinStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-int-chat-'))
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, Buffer.alloc(32, 3))
    const paths = { mcpConfigPath: join(dir, 'mcp.yaml'), mcpPinsPath: join(dir, 'pins.json') }
    const wiring = createIntegrationWiring({ paths, store, audit: { logEvent: () => undefined }, catalogs })
    await wiring.service.add({ id: 'github', access: { agents: ['codex'] }, credentials: { 'github-pat': PAT } }, { via: 'cli' })
    pins = new ToolPinStore(paths.mcpPinsPath)
    notices = []
    ctx = {
      service: wiring.service,
      confirmations: new ConfirmationStore(),
      surface: 'slack',
      user: 'U0123',
      owner: true,
      notice: (t) => void notices.push(t),
    }
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const review = () => {
    const server = loadHubConfig(join(dir, 'mcp.yaml')).servers.github!
    pins.pin('github', launchFingerprint(server), [{ name: 'get_me', description: 'who', inputSchema: {} }])
  }

  it('lists and shows status with names only, never values', async () => {
    expect(await integrationChat([], ctx)).toMatch(/⚠ github — read-only, not reviewed, codex/)
    const status = await integrationChat(['status', 'gh'], ctx)
    expect(status).toContain('credentials: github-pat stored')
    expect(status).not.toContain(PAT)
  })

  it('keeps adding and credentials on the host', async () => {
    expect(await integrationChat(['add', 'linear', 'lin_api_x'], ctx)).toMatch(/runs on the Foreman host, never in chat/)
  })

  it('refuses changes from someone who is not an owner', async () => {
    const reply = await integrationChat(['disable', 'github'], { ...ctx, owner: false })
    expect(reply).toMatch(/Only you can disable an integration/)
    expect(notices).toEqual([])
  })

  it('reports a refused change as a failure through the router (audit log, relaying agent)', async () => {
    const router = new ForemanCommandRouter()
    registerBuiltinCommands(router)
    const base = { db: {} as never, registry: {} as never, llmConfigPath: '', configDir: dir, integrations: { service: ctx.service! } }
    // A Slack sender who is allowed but not in owner_user_ids, and an agent relaying it.
    const notOwner = await router.dispatch('integration', ['disable', 'github'], { ...base, sourceAgent: 'slack', sourceUser: 'slack:U2', trustedOwner: true, integrationOwner: false })
    const relayed = await router.dispatch('integration', ['disable', 'github'], { ...base, sourceAgent: 'codex' })
    for (const res of [notOwner, relayed]) {
      expect(res).toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' })
      expect(res.text).toMatch(/Only you can disable an integration/)
    }
    // Reads stay fine for both.
    expect(await router.dispatch('integration', ['status', 'github'], { ...base, sourceAgent: 'codex' })).toMatchObject({ ok: true })
    expect(await router.dispatch('integrations', [], { ...base, sourceAgent: 'codex' })).toMatchObject({ ok: true })
    const owner = await router.dispatch('integration', ['disable', 'github'], { ...base, sourceAgent: 'slack', sourceUser: 'slack:U1', trustedOwner: true, integrationOwner: true })
    expect(owner).toMatchObject({ ok: true })
    expect(owner.text).toMatch(/github disabled/)
  })

  it('refuses to enable before review, then enables and tells the inbox', async () => {
    expect(await integrationChat(['enable', 'github'], ctx)).toMatch(/stays disabled: .*not been reviewed/)
    review()
    expect(await integrationChat(['enable', 'github'], ctx)).toMatch(/github enabled/)
    expect(notices).toEqual(['github enabled from Slack by U0123'])
    expect(await integrationChat(['disable', 'github'], ctx)).toMatch(/github disabled/)
  })

  it('removes only with the code issued to the same person', async () => {
    const first = await integrationChat(['remove', 'github'], ctx)
    const code = /confirm ([A-Z2-9]{6})/.exec(first)![1]!
    expect(await integrationChat(['remove', 'github', 'confirm', code], { ...ctx, user: 'U999' })).toMatch(/isn't valid/)
    expect(loadHubConfig(join(dir, 'mcp.yaml')).servers.github).toBeDefined()
    const second = /confirm ([A-Z2-9]{6})/.exec(await integrationChat(['remove', 'github'], ctx))![1]!
    expect(await integrationChat(['remove', 'github', 'confirm', second], ctx)).toMatch(/github removed/)
    expect(loadHubConfig(join(dir, 'mcp.yaml')).servers.github).toBeUndefined()
    expect(store.exists('github-pat')).toBe(false)
  })

  it('clips replies to each surface', () => {
    const long = 'x'.repeat(5000)
    expect(clipForSurface(long, 'discord')).toHaveLength(1900)
    expect(clipForSurface(long, 'telegram')).toHaveLength(3900)
    expect(clipForSurface(long, 'slack')).toHaveLength(3500)
  })
})

describe('integration commands through the router', () => {
  const router = new ForemanCommandRouter()
  registerBuiltinCommands(router)
  const registry = { findByCommandToken: () => ({ kind: 'none' as const }) }

  it('lets a relay read integrations but never change them', () => {
    expect(relayedCommandAccess(router, registry, 'integrations', [])).toBe('read')
    expect(relayedCommandAccess(router, registry, 'integration', ['status', 'github'])).toBe('read')
    expect(relayedCommandAccess(router, registry, 'integration', [])).toBe('read')
    for (const sub of ['enable', 'disable', 'remove', 'add']) {
      expect(relayedCommandAccess(router, registry, 'integration', [sub, 'github'])).toBe('owner-surface')
    }
  })
})

describe('isIntegrationOwner', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-int-owner-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('uses owner_user_ids when set, else allowed_user_ids, and closes on a broken file', () => {
    const path = join(dir, 'notify.yaml')
    writeFileSync(
      path,
      [
        'channels:',
        '  slack: { enabled: true, allowed_user_ids: [U1, U2], owner_user_ids: [U1] }',
        '  discord: { enabled: true, allowed_user_ids: ["111"] }',
        '',
      ].join('\n'),
    )
    expect(isIntegrationOwner(path, 'slack', 'U1')).toBe(true)
    expect(isIntegrationOwner(path, 'slack', 'U2')).toBe(false)
    expect(isIntegrationOwner(path, 'discord', '111')).toBe(true)
    expect(isIntegrationOwner(path, 'discord', '222')).toBe(false)
    expect(isIntegrationOwner(path, 'telegram', 'anything')).toBe(true)
    writeFileSync(path, 'channels: [broken')
    expect(isIntegrationOwner(path, 'slack', 'U1')).toBe(false)
  })
})
