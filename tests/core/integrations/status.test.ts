import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  blockingProblems,
  describeAccess,
  integrationStatus,
  launchFingerprint,
} from '../../../src/core/integrations/status.js'
import { defaultHubConfig, parseHubConfigText } from '../../../src/core/mcp-hub/config.js'
import { ToolPinStore } from '../../../src/core/mcp-hub/pins.js'

const server = parseHubConfigText(
  [
    'servers:',
    '  github:',
    '    enabled: true',
    '    url: https://api.githubcopilot.com/mcp/',
    '    headers: { Authorization: "Bearer ${secret:github-pat}" }',
    '    tools: { allow: [get_*], deny: [delete_*], confirm: [merge_*] }',
    '',
  ].join('\n'),
).servers.github!

describe('integrationStatus', () => {
  let dir: string
  let pins: ToolPinStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-int-status-'))
    pins = new ToolPinStore(join(dir, 'pins.json'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const status = (present: boolean) =>
    integrationStatus('github', server, {
      pins,
      secrets: { exists: () => present, get: () => 'x' },
      security: defaultHubConfig().security,
    })

  it('flags a missing secret and an unreviewed server as blocking', () => {
    const s = status(false)
    expect(s.state).toBe('attention')
    expect(blockingProblems(s).map((p) => p.kind).sort()).toEqual(['missing-secret', 'not-reviewed'])
    expect(s.missingSecrets).toEqual(['github-pat'])
  })

  it('counts tools by rule and withholds drifted and new ones', () => {
    const fp = launchFingerprint(server)
    pins.pin('github', fp, [
      { name: 'get_me', description: 'who am i', inputSchema: {} },
      { name: 'merge_pull_request', description: 'merge', inputSchema: {} },
      { name: 'delete_repo', description: 'delete', inputSchema: {} },
      { name: 'create_issue', description: 'create', inputSchema: {} },
    ])
    let s = status(true)
    expect(s.reviewed).toBe(true)
    expect(s.state).toBe('enabled')
    expect(s.tools).toEqual({ total: 4, allow: 1, ask: 1, confirm: 1, deny: 1, withheld: 0 })

    pins.recordDrift('github', fp, { changed: ['get_me', 'delete_repo'], added: ['push_files'] })
    s = status(true)
    expect(s.withheld.map((w) => w.tool).sort()).toEqual(['get_me', 'push_files'])
    expect(s.problems.map((p) => p.kind).sort()).toEqual(['drift', 'withheld'])
    expect(blockingProblems(s)).toEqual([])
  })

  it('is not reviewed once the launch config changes', () => {
    pins.pin('github', launchFingerprint(server), [{ name: 'get_me', description: 'x', inputSchema: {} }])
    const moved = { ...server, url: 'https://other.example.com/mcp' }
    const s = integrationStatus('github', moved, {
      pins,
      secrets: { exists: () => true, get: () => 'x' },
      security: defaultHubConfig().security,
    })
    expect(s.reviewed).toBe(false)
  })
})

describe('describeAccess', () => {
  it('spells out who may use a server', () => {
    expect(describeAccess(undefined)).toBe('every verified agent')
    expect(describeAccess({})).toBe('nobody')
    expect(describeAccess({ agents: ['codex'], departments: ['eng', 'ops'] })).toBe('codex, departments eng, ops')
  })
})
