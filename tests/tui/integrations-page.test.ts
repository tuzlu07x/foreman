import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadHubConfig, parseHubConfigText, toolRuleLevel } from '../../src/core/mcp-hub/config.js'
import { createIntegrationWiring, loadIntegrationCatalogs } from '../../src/core/integrations/wiring.js'
import type { IntegrationStatus } from '../../src/core/integrations/status.js'
import { SecretStore } from '../../src/core/secret-store.js'
import {
  accessFromSelection,
  addSteps,
  buildIntegrationRows,
  currentOverride,
  cycleToolRule,
  EVERYONE,
  removalPlan,
  rowSummary,
  suggestedAgents,
  type ConfiguredRow,
} from '../../src/tui/integrations-page-logic.js'
import { mountApp, type MountedApp } from '../support/tui-app.js'

const catalogs = loadIntegrationCatalogs()
const entry = (id: string) => catalogs.integrations.integrations.find((e) => e.id === id)!
const PAT = `ghp_${'A'.repeat(36)}`

describe('integrations page logic', () => {
  const config = parseHubConfigText(
    [
      'servers:',
      '  plain: { command: node, env: { T: "${secret:shared}" } }',
      '  github:',
      '    url: https://api.githubcopilot.com/mcp/',
      '    headers: { Authorization: "Bearer ${secret:github-pat}", X: "${secret:shared}" }',
      '    integration: { id: github, variant: official, access_level: read-only, created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z", tool_overrides: { deny: [get_me] } }',
      '',
    ].join('\n'),
  )
  const status = { tools: { total: 41, allow: 20, ask: 2, confirm: 1, deny: 18, withheld: 0 } } as unknown as IntegrationStatus

  it('lists configured integrations first, then what is still available', () => {
    const rows = buildIntegrationRows(config, catalogs.integrations, () => status)
    expect(rows[0]).toMatchObject({ kind: 'configured', name: 'github' })
    expect(rows.slice(1).map((r) => (r.kind === 'available' ? r.entry.id : r.name))).not.toContain('github')
    expect(rows.some((r) => r.kind === 'configured' && r.name === 'plain')).toBe(false)
    expect(rowSummary(rows[0] as ConfiguredRow)).toBe('official · token · read-only · 41 tools · 3 ask')
  })

  it('asks only for the steps a variant needs', () => {
    const linear = entry('linear')
    expect(addSteps(linear, null, catalogs.mcp)).toEqual(['variant', 'params', 'level', 'who', 'credentials'])
    const oauth = linear.variants.find((v) => v.auth.kind === 'oauth')!
    expect(addSteps(linear, oauth, catalogs.mcp)).toEqual(['variant', 'level', 'who'])
    const gitlab = entry('gitlab')
    const official = gitlab.variants.find((v) => v.id === 'official')!
    expect(addSteps(gitlab, official, catalogs.mcp)).toEqual(['variant', 'params', 'level', 'who'])
  })

  it('turns the who-picker into an access choice', () => {
    expect(accessFromSelection([EVERYONE, 'codex'])).toBe('all')
    expect(accessFromSelection(['codex', 'dept:eng'])).toEqual({ agents: ['codex'], departments: ['eng'] })
    expect(accessFromSelection([])).toBeNull()
    expect(suggestedAgents(entry('github'), ['codex', 'hermes'])).toEqual(['codex'])
    expect(suggestedAgents(entry('github'), ['hermes'])).toEqual(['hermes'])
  })

  it('cycles tool rules and reads the current override', () => {
    expect(cycleToolRule('default', 1)).toBe('allow')
    expect(cycleToolRule('default', -1)).toBe('deny')
    expect(cycleToolRule('deny', 1)).toBe('default')
    expect(currentOverride(config.servers.github!, 'get_me')).toBe('deny')
    expect(currentOverride(config.servers.github!, 'list_issues')).toBe('default')
  })

  it('removes only the secrets nothing else uses', () => {
    expect(removalPlan(config, 'github', null)).toEqual({ deletes: ['github-pat'], shared: ['shared'], signsOut: false, revokeUrl: null })
  })
})

describe('Integrations page (i)', () => {
  let dir: string
  let m: MountedApp
  let store: SecretStore
  const mcp = () => join(dir, 'mcp.yaml')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-int-tui-'))
  })
  afterEach(() => {
    m.unmount()
    rmSync(dir, { recursive: true, force: true })
  })

  const mount = async (): Promise<void> => {
    m = await mountApp(({ db, registry }) => {
      store = new SecretStore(db, Buffer.alloc(32, 7))
      registry.register({ id: 'codex', displayName: 'Codex', transport: 'stdio' })
      const wiring = createIntegrationWiring({
        paths: { mcpConfigPath: mcp(), mcpPinsPath: join(dir, 'pins.json') },
        store,
        audit: { logEvent: () => undefined },
        catalogs,
      })
      void wiring.service.add({ id: 'github', access: { agents: ['codex'] }, credentials: { 'github-pat': PAT } }, { via: 'cli' })
      return { secretStore: store, integrations: wiring }
    })
    await m.press('', 200)
    await m.press('i', 150)
  }

  it('shows configured and available integrations', async () => {
    await mount()
    const frame = m.frame()
    expect(frame).toContain('Integrations')
    expect(frame).toMatch(/github\s+official · token · read-only · not reviewed · codex/)
    expect(frame).toContain('Available:')
    expect(frame).toContain('Linear')
  })

  it('refuses to enable an unreviewed integration and says why', async () => {
    await mount()
    await m.press(' ', 200)
    expect(m.frame()).toMatch(/github stays disabled: tool definitions have not been reviewed/)
    expect(loadHubConfig(mcp()).servers.github!.enabled).toBe(false)
  })

  it('switches the access level from the edit menu', async () => {
    await mount()
    await m.press('e', 100)
    expect(m.frame()).toContain('Access level: read-only → read-write')
    await m.press('\r', 250)
    const server = loadHubConfig(mcp()).servers.github!
    expect(server.integration!.access_level).toBe('read-write')
    expect(toolRuleLevel(server.tools, 'issue_write')).not.toBe('deny')
  })

  it('removes only after an explicit yes (Enter cancels)', async () => {
    await mount()
    await m.press('d', 100)
    expect(m.frame()).toContain('Remove github?')
    await m.press('\r', 200)
    expect(loadHubConfig(mcp()).servers.github).toBeDefined()
    await m.press('d', 100)
    await m.press('y', 300)
    expect(loadHubConfig(mcp()).servers.github).toBeUndefined()
    expect(store.exists('github-pat')).toBe(false)
  })
})
