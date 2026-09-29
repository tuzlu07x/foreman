import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrg, parseOrgText, validateOrg } from '../../src/core/org/org.js'
import { DEPARTMENT_PRESETS, departmentRolePresets, generalRolePresets, ROLE_PRESETS } from '../../src/core/org/role-library.js'
import {
  addDepartment,
  applyTeam,
  departmentRuntime,
  existingDepartmentIds,
  existingRoleIds,
  nextRuntime,
  planTeam,
  removeDepartment,
  reportingLine,
  scrollWindow,
  slugify,
  switchDepartmentRuntime,
  teamChoices,
  teamPickRows,
  teamRuntimes,
  toggleDepartment,
  wrappedLines,
  type TeamCustomRole,
  type TeamDepartment,
  type TeamRuntime,
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
    expect(result).toEqual({ added: [], failed: [{ title: 'Developer', reason: 'boom' }], departments: [], orgError: null })
    expect(existingRoleIds(orgPath)).toEqual([])
  })
})

// ---- Departments ----

const BOTH = ['claude-code', 'codex'] as const
const IT: TeamDepartment = { key: 'dept:1', presetId: 'it', name: 'IT', runsOn: 'codex' }
const MARKETING: TeamDepartment = { key: 'dept:2', presetId: 'marketing', name: 'Marketing', runsOn: 'claude-code' }
const SALES: TeamDepartment = { key: 'dept:3', name: 'Sales', runsOn: 'claude-code' }
const CLOSER: TeamCustomRole = { title: 'Closer', instructions: 'Close deals.', can: ['read', 'network'], department: 'dept:3' }

/** Every org.yaml the team step writes must load as-is. */
function expectValid(orgPath: string): void {
  const text = readFileSync(orgPath, 'utf-8')
  expect(() => parseOrgText(text)).not.toThrow()
  expect(validateOrg(parseOrgText(text)).filter((i) => i.level === 'error')).toEqual([])
}

describe('ready-made departments', () => {
  it('offers department roles only inside their department, with ids that never clash with a role', () => {
    const general = generalRolePresets().map((p) => p.id)
    expect(general).toContain('manager')
    expect(general).not.toContain('backend-developer')
    expect(DEPARTMENT_PRESETS.map((d) => d.id)).toEqual(['it', 'marketing', 'customer-support'])
    for (const d of DEPARTMENT_PRESETS) {
      expect(ROLE_PRESETS.some((p) => p.id === d.id)).toBe(false)
      for (const id of d.roles) expect(ROLE_PRESETS.find((p) => p.id === id)?.department).toBe(d.id)
    }
    const itDept = DEPARTMENT_PRESETS.find((d) => d.id === "it")!
    expect(departmentRolePresets(itDept).map((p) => [p.id, p.runsOn])).toEqual([
      ['backend-developer', 'codex'],
      ['frontend-developer', 'codex'],
      ['devops-engineer', 'codex'],
    ])
    expect(ROLE_PRESETS.find((p) => p.id === 'devops-engineer')?.can).toEqual(['read', 'write', 'shell', 'network'])
  })
})

describe('department picker helpers', () => {
  it('lists roles on their own, then each department under its header, then the two add rows', () => {
    const choices = teamChoices([{ title: 'Chores', instructions: '', can: [] }, CLOSER], [...BOTH], {}, [IT, SALES])
    const picked = ['dept:1:frontend-developer', 'dept:1:devops-engineer']
    const rows = teamPickRows(choices, [IT, SALES], picked)
    const labels = rows.map((r) =>
      r.kind === 'role' ? `${r.choice.key}${r.lead ? ' (lead)' : ''}` : r.kind === 'department' ? `# ${r.department.name}` : r.kind,
    )
    expect(labels.slice(8)).toEqual([
      'custom:0',
      '# IT',
      'dept:1:backend-developer',
      'dept:1:frontend-developer (lead)',
      'dept:1:devops-engineer',
      '# Sales',
      'custom:1',
      'own-role',
      'add-department',
    ])
    // A department's roles run on what it runs on, unless switched one by one.
    expect(choices.find((c) => c.key === 'custom:1')?.runsOn).toBe('claude-code')
    expect(choices.filter((c) => c.department === 'dept:1').every((c) => c.runsOn === 'codex')).toBe(true)
  })

  it('adds departments with keys that survive a removal', () => {
    const one = addDepartment([], { presetId: 'it', name: 'IT', runsOn: 'codex' })
    const two = addDepartment(one.departments, { name: 'Sales', runsOn: 'claude-code' })
    expect([one.key, two.key]).toEqual(['dept:1', 'dept:2'])
    const three = addDepartment(two.departments.slice(1), { name: 'Ops', runsOn: 'codex' })
    expect(three.key).toBe('dept:3')
  })

  it('Space on a department picks all its roles, or none when all are picked', () => {
    const choices = teamChoices([], [...BOTH], {}, [IT])
    const all = toggleDepartment(['preset:manager', 'dept:1:devops-engineer'], choices, 'dept:1')
    expect(all).toEqual(['preset:manager', 'dept:1:devops-engineer', 'dept:1:backend-developer', 'dept:1:frontend-developer'])
    expect(toggleDepartment(all, choices, 'dept:1')).toEqual(['preset:manager'])
  })

  it('r on a department switches every role in it, and back', () => {
    let departments = [IT]
    let runsOn: Record<string, TeamRuntime> = { 'dept:1:devops-engineer': 'claude-code' }
    let choices = teamChoices([], [...BOTH], runsOn, departments)
    const itDept = departments[0]!
    expect(departmentRuntime(itDept, choices.filter((c) => c.department === 'dept:1'))).toBe('mixed')
    ;({ departments, runsOn } = switchDepartmentRuntime(departments, runsOn, choices, 'dept:1', [...BOTH]))
    choices = teamChoices([], [...BOTH], runsOn, departments)
    expect(choices.filter((c) => c.department === 'dept:1').map((c) => c.runsOn)).toEqual(['claude-code', 'claude-code', 'claude-code'])
    ;({ departments, runsOn } = switchDepartmentRuntime(departments, runsOn, choices, 'dept:1', [...BOTH]))
    choices = teamChoices([], [...BOTH], runsOn, departments)
    expect(choices.filter((c) => c.department === 'dept:1').map((c) => c.runsOn)).toEqual(['codex', 'codex', 'codex'])
    // Only one agent registered: nothing to switch to.
    expect(switchDepartmentRuntime(departments, runsOn, choices, 'dept:1', ['codex']).departments[0]!.runsOn).toBe('codex')
  })

  it('removing a department drops its roles and renumbers your own roles', () => {
    const custom: TeamCustomRole[] = [
      { title: 'A', instructions: '', can: [], department: 'dept:1' },
      { title: 'B', instructions: '', can: [] },
      CLOSER,
    ]
    const next = removeDepartment(
      {
        departments: [IT, SALES],
        custom,
        picked: ['custom:0', 'custom:1', 'custom:2', 'dept:1:backend-developer', 'preset:manager'],
        runsOn: { 'custom:2': 'codex', 'dept:1:devops-engineer': 'claude-code', 'preset:developer': 'claude-code' },
      },
      'dept:1',
    )
    expect(next.departments).toEqual([SALES])
    expect(next.custom.map((c) => c.title)).toEqual(['B', 'Closer'])
    expect(next.picked).toEqual(['custom:0', 'custom:1', 'preset:manager'])
    expect(next.runsOn).toEqual({ 'custom:1': 'codex', 'preset:developer': 'claude-code' })
  })

  it('says who reports to whom', () => {
    const choices = teamChoices([], [...BOTH], {}, [IT, MARKETING])
    const pick = (...keys: string[]) => choices.filter((c) => keys.includes(c.key))
    expect(reportingLine(pick('preset:manager', 'dept:1:backend-developer', 'dept:1:devops-engineer'), [IT, MARKETING])).toBe(
      "IT's lead reports to the Manager; the rest of IT reports to its lead. The Manager reports to you.",
    )
    expect(reportingLine(pick('preset:developer', 'dept:1:backend-developer', 'dept:2:content-creator'), [IT, MARKETING])).toBe(
      "Each department's lead reports to you; the rest report to their lead. Everyone else reports to you.",
    )
    expect(reportingLine(pick('preset:manager'), [IT])).toBe('Everyone reports to the Manager, who reports to you.')
  })

  it('works out how many lines wrapped text takes, and which rows fit', () => {
    expect(wrappedLines('one two three', 80)).toBe(1)
    expect(wrappedLines('aaaa bbbb cccc', 10)).toBe(2)
    expect(scrollWindow(5, 4, 10)).toEqual({ start: 0, end: 5, above: 0, below: 0 })
    expect(scrollWindow(20, 0, 10)).toEqual({ start: 0, end: 8, above: 0, below: 12 })
    expect(scrollWindow(20, 19, 10)).toEqual({ start: 12, end: 20, above: 12, below: 0 })
    const mid = scrollWindow(20, 10, 10)
    expect(mid.start <= 10 && 10 < mid.end).toBe(true)
  })
})

describe('planTeam with departments', () => {
  const plan = (keys: string[], opts: { existingRoles?: string[]; existingDepts?: string[]; manager?: string } = {}) => {
    const departments = [IT, SALES]
    const choices = teamChoices([CLOSER, { title: 'Hunter', instructions: '', can: ['read'], department: 'dept:3' }], [...BOTH], {}, departments)
    return planTeam(
      choices.filter((c) => keys.includes(c.key)),
      opts.existingRoles ?? [],
      [],
      opts.manager,
      departments,
      opts.existingDepts ?? [],
    )
  }

  it('the lead reports to the Manager and the rest of the department to the lead', () => {
    const members = plan(['preset:manager', 'preset:developer', 'dept:1:backend-developer', 'dept:1:frontend-developer', 'dept:1:devops-engineer'])
    expect(members.map((m) => `${m.roleId}→${m.reportsTo}${m.department ? ` [${m.department}${m.lead ? ' lead' : ''}]` : ''}`)).toEqual([
      'manager→human',
      'developer→manager',
      'backend-developer→manager [it lead]',
      'frontend-developer→backend-developer [it]',
      'devops-engineer→backend-developer [it]',
    ])
    expect(members.every((m) => (m.department === 'it' ? m.runsOn === 'codex' : true))).toBe(true)
  })

  it('with no Manager the lead reports to an existing manager, else to you; the first picked role leads', () => {
    expect(plan(['dept:1:frontend-developer', 'dept:1:devops-engineer']).map((m) => `${m.roleId}→${m.reportsTo}`)).toEqual([
      'frontend-developer→human',
      'devops-engineer→frontend-developer',
    ])
    expect(plan(['dept:1:devops-engineer'], { existingRoles: ['manager'], manager: 'manager' })[0]?.reportsTo).toBe('manager')
  })

  it('never gives a department an id a department, a role or a reserved word already has', () => {
    const members = plan(['custom:0', 'custom:1', 'dept:1:backend-developer'], {
      existingRoles: ['sales', 'closer'],
      existingDepts: ['it'],
    })
    expect(members.map((m) => [m.roleId, m.department])).toEqual([
      ['backend-developer', 'it-2'],
      ['closer-2', 'sales-2'],
      ['hunter', 'sales-2'],
    ])
    const boss = planTeam(
      teamChoices([{ title: 'Boss', instructions: '', can: [], department: 'dept:9' }], [...BOTH], {}, [
        { key: 'dept:9', name: 'All', runsOn: 'codex' },
      ]),
      [],
      [],
      undefined,
      [{ key: 'dept:9', name: 'All', runsOn: 'codex' }],
    ).filter((m) => m.department)
    expect(boss.map((m) => [m.roleId, m.department])).toEqual([['boss-2', 'all-2']])
  })
})

describe('applyTeam with departments', () => {
  let dir: string
  let orgPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-team-dept-'))
    orgPath = join(dir, 'org.yaml')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const departments = [IT, SALES]
  const members = (keys: string[]) => {
    const choices = teamChoices([CLOSER], [...BOTH], {}, departments)
    return planTeam(choices.filter((c) => keys.includes(c.key)), existingRoleIds(orgPath), [], undefined, departments, existingDepartmentIds(orgPath))
  }
  const failing = (...ids: string[]) => async (id: string) => (ids.includes(id) ? `${id} failed` : null)

  it('writes the departments before the roles, each led by its lead, in one valid org.yaml', async () => {
    const result = await applyTeam(members(['preset:manager', 'dept:1:backend-developer', 'dept:1:frontend-developer', 'custom:0']), {
      orgConfigPath: orgPath,
      company: 'Acme',
      addAgent: async () => null,
    })
    expect(result.orgError).toBeNull()
    expect(result.departments).toEqual([
      { id: 'it', name: 'IT', head: 'backend-developer' },
      { id: 'sales', name: 'Sales', head: 'closer' },
    ])
    expectValid(orgPath)
    const text = readFileSync(orgPath, 'utf-8')
    expect(text.indexOf('departments:')).toBeLessThan(text.indexOf('roles:'))
    expect(text).toMatch(/departments:\n\s+it:\n\s+name: IT\n\s+head: backend-developer\n\s+sales:\n\s+name: Sales\n\s+head: closer/)
    const org = loadOrg(orgPath)!
    expect(org.roles['backend-developer']).toMatchObject({ agent: 'backend-developer', department: 'it', reports_to: 'manager' })
    expect(org.roles['frontend-developer']).toMatchObject({ department: 'it', reports_to: 'backend-developer', can: ['read', 'write', 'shell'] })
    expect(org.roles.closer).toMatchObject({ department: 'sales', reports_to: 'manager', instructions: 'Close deals.' })
  })

  it('promotes the first added role when the lead fails, and the rest report to it', async () => {
    const result = await applyTeam(members(['preset:manager', 'dept:1:backend-developer', 'dept:1:frontend-developer', 'dept:1:devops-engineer']), {
      orgConfigPath: orgPath,
      company: 'Acme',
      addAgent: failing('backend-developer'),
    })
    expect(result.failed).toEqual([{ title: 'Backend Developer', reason: 'backend-developer failed' }])
    expect(result.departments).toEqual([{ id: 'it', name: 'IT', head: 'frontend-developer' }])
    expect(result.added.find((m) => m.roleId === 'frontend-developer')).toMatchObject({ lead: true, reportsTo: 'manager' })
    expectValid(orgPath)
    const org = loadOrg(orgPath)!
    expect(org.departments.it?.head).toBe('frontend-developer')
    expect(org.roles['frontend-developer']?.reports_to).toBe('manager')
    expect(org.roles['devops-engineer']?.reports_to).toBe('frontend-developer')
  })

  it('leaves out a department with no role added', async () => {
    const result = await applyTeam(members(['preset:developer', 'dept:1:backend-developer', 'dept:1:devops-engineer']), {
      orgConfigPath: orgPath,
      company: 'Acme',
      addAgent: failing('backend-developer', 'devops-engineer'),
    })
    expect(result.departments).toEqual([])
    expect(result.added.map((m) => m.roleId)).toEqual(['developer'])
    expectValid(orgPath)
    expect(loadOrg(orgPath)!.departments).toEqual({})
    expect(readFileSync(orgPath, 'utf-8')).not.toContain('departments:')
  })

  it('re-points anyone reporting to a role that failed to that role’s manager', async () => {
    const result = await applyTeam(members(['preset:manager', 'preset:developer', 'dept:1:backend-developer', 'dept:1:frontend-developer']), {
      orgConfigPath: orgPath,
      company: 'Acme',
      addAgent: failing('manager', 'backend-developer'),
    })
    expect(result.added.map((m) => `${m.roleId}→${m.reportsTo}`)).toEqual(['developer→human', 'frontend-developer→human'])
    expect(result.departments).toEqual([{ id: 'it', name: 'IT', head: 'frontend-developer' }])
    expectValid(orgPath)
  })

  it('adds departments to an existing org.yaml before its roles, keeping comments and ids', async () => {
    writeFileSync(
      orgPath,
      '# ours\nversion: 1\ncompany: Acme\nroles:\n  it:\n    title: IT person\n    agent: claude-code\n    reports_to: human\n',
    )
    const result = await applyTeam(members(['dept:1:backend-developer', 'dept:1:frontend-developer']), {
      orgConfigPath: orgPath,
      company: '',
      addAgent: async () => null,
    })
    expect(result.orgError).toBeNull()
    expect(result.departments).toEqual([{ id: 'it-2', name: 'IT', head: 'backend-developer' }])
    expectValid(orgPath)
    const text = readFileSync(orgPath, 'utf-8')
    expect(text).toContain('# ours')
    expect(text.indexOf('departments:')).toBeLessThan(text.indexOf('roles:'))
    expect(Object.keys(loadOrg(orgPath)!.roles)).toEqual(['it', 'backend-developer', 'frontend-developer'])
  })

  it('every combination it writes passes validation', async () => {
    const keys = ['preset:manager', 'preset:researcher', 'dept:1:backend-developer', 'dept:1:frontend-developer', 'dept:1:devops-engineer', 'custom:0']
    // Each subset of roles failing, one run each (2^6 = 64 runs).
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      rmSync(orgPath, { force: true })
      const plan = members(keys)
      const fails = plan.filter((_, i) => (mask >> i) & 1).map((m) => m.agentId)
      const result = await applyTeam(plan, { orgConfigPath: orgPath, company: 'Acme', addAgent: failing(...fails) })
      expect(result.orgError).toBeNull()
      if (result.added.length > 0) expectValid(orgPath)
      expect(result.added.length + result.failed.length).toBe(keys.length)
    }
  })
})
