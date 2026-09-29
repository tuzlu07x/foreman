import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrg } from '../../src/core/org/org.js'
import {
  applyTeam,
  existingRoleIds,
  nextRuntime,
  planTeam,
  slugify,
  teamChoices,
  teamRuntimes,
} from '../../src/tui/setup-wizard/team-logic.js'

// The setup wizard's "Your team" step: roles on Claude Code / Codex
// instances, written to org.yaml.

describe('team choices', () => {
  it('runs roles only on Claude Code or Codex, whichever is registered', () => {
    expect(teamRuntimes(['hermes', 'codex'])).toEqual(['codex'])
    expect(teamRuntimes(['hermes'])).toEqual([])
    const onlyCodex = teamChoices([], ['codex'], {})
    expect(onlyCodex.every((c) => c.runsOn === 'codex')).toBe(true)
    const both = teamChoices([], ['claude-code', 'codex'], {})
    expect(both.find((c) => c.presetId === 'developer')?.runsOn).toBe('codex')
    expect(both.find((c) => c.presetId === 'manager')?.runsOn).toBe('claude-code')
    expect(nextRuntime('claude-code', ['claude-code', 'codex'])).toBe('codex')
    expect(nextRuntime('codex', ['codex'])).toBe('codex')
  })

  it('makes an id from your own title', () => {
    expect(slugify('Social media!')).toBe('social-media')
    expect(slugify('Çöp işler')).toBe('cop-isler')
    expect(slugify('!!!')).toBe('role')
  })
})

describe('planTeam', () => {
  const pick = (ids: string[]) =>
    teamChoices([{ title: 'Chores', instructions: 'Tidy up.', can: ['read'] }], ['claude-code', 'codex'], {}).filter((c) =>
      ids.includes(c.presetId ?? 'custom'),
    )

  it('reports to the manager when there is one, else to you', () => {
    const withManager = planTeam(pick(['manager', 'developer', 'custom']), [], [])
    expect(withManager.map((m) => `${m.roleId}→${m.reportsTo}`)).toEqual(['manager→human', 'developer→manager', 'chores→manager'])
    expect(planTeam(pick(['developer']), [], [])[0]?.reportsTo).toBe('human')
  })

  it('never reuses a role or agent id that is taken', () => {
    const plan = planTeam(pick(['developer', 'custom']), ['developer'], ['chores', 'chores-2'])
    expect(plan.map((m) => [m.roleId, m.agentId])).toEqual([
      ['developer-2', 'developer-2'],
      ['chores-3', 'chores-3'],
    ])
  })
})

describe('applyTeam', () => {
  let dir: string
  let orgPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-team-'))
    orgPath = join(dir, 'org.yaml')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const choices = teamChoices([], ['claude-code', 'codex'], {})
  const members = (ids: string[]) => planTeam(choices.filter((c) => ids.includes(c.presetId!)), existingRoleIds(orgPath), [])

  it('creates org.yaml with the roles whose instance was added, and reports the rest', async () => {
    const result = await applyTeam(members(['manager', 'researcher']), {
      orgConfigPath: orgPath,
      company: '  ',
      addAgent: async (id) => (id === 'researcher' ? 'claude not found' : null),
    })
    expect(result.failed).toEqual([{ title: 'Researcher', reason: 'claude not found' }])
    expect(result.added.map((m) => m.roleId)).toEqual(['manager'])
    const org = loadOrg(orgPath)!
    expect(org.company).toBe('My team')
    expect(org.roles.manager).toMatchObject({ agent: 'manager', reports_to: 'human', can: ['read'] })
    expect(org.roles.researcher).toBeUndefined()
  })

  it('adds to an existing org.yaml, keeping its comments and roles', async () => {
    writeFileSync(orgPath, '# ours\nversion: 1\ncompany: Acme\nroles:\n  cto:\n    title: CTO\n    agent: claude-code\n    reports_to: human\n')
    const result = await applyTeam(members(['developer']), { orgConfigPath: orgPath, company: '', addAgent: async () => null })
    expect(result.orgError).toBeNull()
    const text = readFileSync(orgPath, 'utf-8')
    expect(text).toContain('# ours')
    expect(Object.keys(loadOrg(orgPath)!.roles)).toEqual(['cto', 'developer'])
  })

  it('leaves a broken org.yaml alone and says why', async () => {
    writeFileSync(orgPath, 'version: 1\ncompany: Acme\nroles: [\n')
    const before = readFileSync(orgPath, 'utf-8')
    const result = await applyTeam(members(['developer']), { orgConfigPath: orgPath, company: '', addAgent: async () => null })
    expect(result.orgError).not.toBeNull()
    expect(result.added).toEqual([])
    expect(readFileSync(orgPath, 'utf-8')).toBe(before)
  })

  it('adds nothing to org.yaml when no instance could be added', async () => {
    const result = await applyTeam(members(['developer']), { orgConfigPath: orgPath, company: 'Acme', addAgent: async () => { throw new Error('boom') } })
    expect(result).toEqual({ added: [], failed: [{ title: 'Developer', reason: 'boom' }], orgError: null })
    expect(existingRoleIds(orgPath)).toEqual([])
  })
})
