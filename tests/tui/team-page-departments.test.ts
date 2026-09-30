import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import React from 'react'
import { render as inkRender, type Instance } from 'ink'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { InboxService } from '../../src/core/inbox.js'
import { parseOrgText } from '../../src/core/org/org.js'
import { RegistryService } from '../../src/core/registry.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { App } from '../../src/tui/app.js'
import { displayWidth } from '../../src/tui/format.js'
import {
  agentsToUnregister,
  checkModelId,
  modelFitsRuntime,
  modelProvider,
  planRemoval,
  removeRoles,
  setRolesModel,
  sharingRoles,
  switchRuntime,
  switchTarget,
  type TeamActionDeps,
} from '../../src/tui/team-actions.js'
import {
  columnNeeds,
  departmentLine,
  modelLabel,
  roleCells,
  teamColumns,
  teamTree,
  type TeamTreeRow,
} from '../../src/tui/team-page-logic.js'

// Team page (t), managed by department: the chart grouped by department,
// each role's runtime and model, and x / r / m on a role or a department.

const ORG = `# Acme's team
version: 1
company: Acme
human:
  title: Founder
departments:
  engineering:
    name: Engineering
    head: lead
  it:
    name: IT
    head: backend
roles:
  lead:
    title: Tech Lead
    agent: claude-code
    department: engineering
    reports_to: human
  reviewer:
    title: Code Reviewer
    agent: reviewer
    department: engineering
    reports_to: lead
    can: [read]
  backend:
    title: Backend Developer
    agent: backend
    department: it
    reports_to: lead # the IT lead reports across to Engineering
  frontend:
    title: Frontend Developer
    agent: frontend
    department: it
    reports_to: backend
  devops:
    title: DevOps Engineer
    agent: devops
    department: it
    reports_to: backend
  chores:
    title: Chores
    agent: chores
    reports_to: human
    can: []
`

const DEFAULTS: Record<string, string | null> = { codex: 'gpt-6-luna', 'claude-code': null }

function newRegistry(): { registry: RegistryService; db: ForemanDb; sqlite: Database.Database; close: () => void } {
  const { db, sqlite } = createInMemoryDb()
  const registry = new RegistryService(db, new EventBus<ForemanEventMap>())
  const add = (id: string, runtime: string, modelVersion?: string): void => {
    registry.register({
      id,
      displayName: id === runtime ? (runtime === 'codex' ? 'Codex' : 'Claude Code') : id,
      transport: 'stdio',
      metadata: { registryId: runtime },
      ...(modelVersion ? { modelVersion } : {}),
    })
  }
  add('claude-code', 'claude-code')
  add('codex', 'codex')
  add('reviewer', 'claude-code')
  add('backend', 'codex', 'gpt-6-sol')
  add('frontend', 'codex')
  add('devops', 'codex')
  return { registry, db, sqlite, close: () => sqlite.close() }
}

const pageAgents = (registry: RegistryService) =>
  registry.listAll().map((a) => ({
    id: a.id,
    registryId: typeof a.metadata?.registryId === 'string' ? a.metadata.registryId : undefined,
    displayName: a.displayName,
    modelVersion: a.modelVersion,
    status: a.status,
  }))

const shape = (rows: TeamTreeRow[]): string[] =>
  rows.map((r) => (r.kind === 'department' ? `[${r.name}]` : `${r.info.prefix}${r.key}`))

describe('the chart by department', () => {
  let reg: ReturnType<typeof newRegistry>
  beforeEach(() => {
    reg = newRegistry()
  })
  afterEach(() => reg.close())

  it('groups roles under their departments, reporting lines inside each, and "No department" last', () => {
    const rows = teamTree(parseOrgText(ORG), pageAgents(reg.registry), new Set(), DEFAULTS)
    expect(shape(rows)).toEqual([
      '[Engineering]',
      '└─ lead',
      '   └─ reviewer',
      '[IT]',
      // Backend reports to Engineering's lead: the root of IT.
      '└─ backend',
      '   ├─ frontend',
      '   └─ devops',
      '[No department]',
      '└─ chores',
    ])
    const it = rows[3]!
    expect(it.kind === 'department' && departmentLine(it)).toBe('IT · 3 roles · led by Backend Developer · Codex')
    const eng = rows[0]!
    expect(eng.kind === 'department' && departmentLine(eng)).toBe('Engineering · 2 roles · led by Tech Lead · Claude Code')
    const none = rows[7]!
    expect(none.kind === 'department' && departmentLine(none)).toBe('No department · 1 role')
  })

  it('a folded department shows only its header, still counting its roles', () => {
    const rows = teamTree(parseOrgText(ORG), pageAgents(reg.registry), new Set(['it']), DEFAULTS)
    expect(shape(rows)).toEqual(['[Engineering]', '└─ lead', '   └─ reviewer', '[IT]', '[No department]', '└─ chores'])
    const it = rows[3]!
    expect(it.kind === 'department' && [it.collapsed, it.roleIds]).toEqual([true, ['backend', 'frontend', 'devops']])
  })

  it('a department mixing Claude Code and Codex says "mixed"', () => {
    reg.registry.remove('devops')
    reg.registry.register({ id: 'devops', displayName: 'devops', transport: 'stdio', metadata: { registryId: 'claude-code' } })
    const rows = teamTree(parseOrgText(ORG), pageAgents(reg.registry), new Set(), DEFAULTS)
    const it = rows.find((r) => r.kind === 'department' && r.key === 'it')!
    expect(it.kind === 'department' && it.runsOn).toBe('mixed')
  })

  it("shows each role's model: set here, the program's own setting, or its default", () => {
    expect(modelLabel('gpt-6-sol', 'codex', 'gpt-6-luna')).toEqual({ text: 'gpt-6-sol (set here)', source: 'set-here' })
    expect(modelLabel(null, 'codex', 'gpt-6-luna')).toEqual({ text: "gpt-6-luna (Codex's setting)", source: 'agent' })
    expect(modelLabel(null, 'claude-code', null)).toEqual({ text: 'default model', source: 'default' })
    const rows = teamTree(parseOrgText(ORG), pageAgents(reg.registry), new Set(), DEFAULTS)
    const info = (id: string) => {
      const r = rows.find((x) => x.kind === 'role' && x.key === id)!
      if (r.kind !== 'role') throw new Error('not a role')
      return r.info
    }
    expect(info('backend').model.text).toBe('gpt-6-sol (set here)')
    expect(info('frontend').model.text).toBe("gpt-6-luna (Codex's setting)")
    expect(info('lead').model.text).toBe('default model')
    expect([info('lead').instance, info('backend').instance]).toEqual([false, true])
    expect([info('chores').registered, info('chores').runsOn, info('chores').model.text]).toEqual([false, null, '—'])
    expect(info('lead').head && info('backend').head && !info('frontend').head).toBe(true)
  })

  it('marks a blocked agent', () => {
    reg.registry.block('frontend')
    const rows = teamTree(parseOrgText(ORG), pageAgents(reg.registry), new Set(), DEFAULTS)
    const r = rows.find((x) => x.kind === 'role' && x.key === 'frontend')!
    const infos = rows.flatMap((x) => (x.kind === 'role' ? [x.info] : []))
    const cols = teamColumns(100, columnNeeds(infos))
    expect(r.kind === 'role' && roleCells(r.info, 100, cols).runtime.trim()).toBe('Codex (blocked)')
  })

  it('a role row is one line that fits its width, whatever the title', () => {
    const org = parseOrgText(ORG.replace('title: Code Reviewer', 'title: "代码审查 🎉 reviewer\\nof every single pull request"'))
    const rows = teamTree(org, pageAgents(reg.registry), new Set(), DEFAULTS)
    const needs = columnNeeds(rows.flatMap((x) => (x.kind === 'role' ? [x.info] : [])))
    for (const width of [40, 76, 96, 140]) {
      const cols = teamColumns(width, needs)
      expect(cols.title + cols.id + cols.runtime + cols.model).toBe(Math.max(24, width))
      // The model keeps room even when the rest is cut.
      expect(cols.model).toBeGreaterThanOrEqual(Math.min(20, Math.floor(width / 4)))
      for (const r of rows) {
        if (r.kind !== 'role') continue
        const c = roleCells(r.info, width, cols)
        const line = `${c.prefix}${c.title}${c.id}${c.runtime}${c.model}`
        expect(line).not.toMatch(/[\n\r\t]/)
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
      }
    }
    const reviewer = rows.find((r) => r.kind === 'role' && r.key === 'reviewer')!
    expect(reviewer.kind === 'role' && roleCells(reviewer.info, 200, teamColumns(200, needs)).title).toContain('⏎')
  })
})

describe('what x / r / m do', () => {
  let dir: string
  let orgPath: string
  let reg: ReturnType<typeof newRegistry>
  let added: [string, string][]
  let removed: string[]
  let addError: string | null
  let deps: TeamActionDeps

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-team-actions-'))
    orgPath = join(dir, 'org.yaml')
    writeFileSync(orgPath, ORG)
    reg = newRegistry()
    added = []
    removed = []
    addError = null
    deps = {
      orgConfigPath: orgPath,
      registry: reg.registry,
      addAgent: async (id, runsOn) => {
        added.push([id, runsOn])
        if (addError) return addError
        reg.registry.register({ id, displayName: id, transport: 'stdio', metadata: { registryId: runsOn } })
        return null
      },
      removeAgent: async (id) => {
        removed.push(id)
        reg.registry.remove(id)
        return null
      },
    }
  })
  afterEach(() => {
    reg.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const org = () => parseOrgText(readFileSync(orgPath, 'utf-8'))

  it('removing a head promotes the next role of its department, which reports where the old head did', () => {
    const plan = planRemoval(parseOrgText(ORG), ['backend'])
    expect(plan).toEqual({
      removed: ['backend'],
      heads: { it: 'frontend' },
      reportsTo: { frontend: 'lead', devops: 'frontend' },
      droppedDepartments: [],
    })
  })

  it('removing a manager re-points its reports to its own manager', () => {
    const plan = planRemoval(parseOrgText(ORG), ['lead'])
    // Engineering's next role leads it and reports to you; IT's head, who
    // reported to the old lead across departments, reports to you too.
    expect(plan.heads).toEqual({ engineering: 'reviewer' })
    expect(plan.reportsTo).toEqual({ reviewer: 'human', backend: 'human' })
  })

  it("a department's last role takes the department with it", () => {
    const plan = planRemoval(parseOrgText(ORG), ['lead', 'reviewer'])
    expect(plan.droppedDepartments).toEqual(['engineering'])
    expect(plan.reportsTo).toEqual({ backend: 'human' })
  })

  it('removing a department removes its roles; roles elsewhere that reported to them move up', () => {
    const plan = planRemoval(parseOrgText(ORG), [], ['engineering'])
    expect(plan.removed.sort()).toEqual(['lead', 'reviewer'])
    expect(plan.droppedDepartments).toEqual(['engineering'])
    expect(plan.reportsTo).toEqual({ backend: 'human' })
  })

  it('x on a role: org.yaml without it (comments kept), its reports re-pointed, its own instance unregistered', async () => {
    const result = await removeRoles(deps, ['backend'])
    expect(result.ok).toBe(true)
    expect(result.message).toBe(
      'Backend Developer removed · Frontend Developer leads IT · DevOps Engineer now reports to Frontend Developer · unregistered backend',
    )
    const o = org()
    expect(o.roles.backend).toBeUndefined()
    expect(o.departments.it).toEqual({ name: 'IT', head: 'frontend' })
    expect(o.roles.frontend?.reports_to).toBe('lead')
    expect(o.roles.devops?.reports_to).toBe('frontend')
    expect(readFileSync(orgPath, 'utf-8')).toContain("# Acme's team")
    expect(removed).toEqual(['backend'])
    expect(reg.registry.get('backend')).toBeNull()
  })

  it('never unregisters Claude Code or Codex themselves, nor an instance another role uses', async () => {
    writeFileSync(orgPath, ORG.replace('    agent: frontend\n', '    agent: devops\n'))
    const o = parseOrgText(readFileSync(orgPath, 'utf-8'))
    expect(agentsToUnregister(o, planRemoval(o, ['lead']), reg.registry)).toEqual([])
    expect(agentsToUnregister(o, planRemoval(o, ['devops']), reg.registry)).toEqual([])
    const result = await removeRoles(deps, ['lead'])
    expect(result.ok).toBe(true)
    expect(removed).toEqual([])
    expect(reg.registry.get('claude-code')).not.toBeNull()
  })

  it("won't remove every role", async () => {
    const result = await removeRoles(deps, ['lead', 'reviewer', 'backend', 'frontend', 'devops', 'chores'])
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/every role/)
    expect(readFileSync(orgPath, 'utf-8')).toBe(ORG)
  })

  it('x on a department: it and its roles go, and their instances', async () => {
    const result = await removeRoles(deps, ['backend', 'frontend', 'devops'], ['it'])
    expect(result).toEqual({ ok: true, message: 'IT removed (3 roles) · unregistered backend, frontend and devops' })
    expect(org().departments.it).toBeUndefined()
    expect(Object.keys(org().roles).sort()).toEqual(['chores', 'lead', 'reviewer'])
  })

  it('an org.yaml that no longer parses changes nothing', async () => {
    writeFileSync(orgPath, `${ORG}\nnot: [valid`)
    const result = await removeRoles(deps, ['backend'])
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/^Couldn't read org.yaml: /)
    expect(result.message).not.toMatch(/\n|at .*\.ts/)
    expect(removed).toEqual([])
  })

  it('knows whose models are whose', () => {
    expect(modelProvider('gpt-6-sol')).toBe('openai')
    expect(modelProvider('claude-sonnet-5')).toBe('anthropic')
    expect(modelProvider('o4-mini')).toBe('openai')
    expect(modelProvider('my-local-model')).toBeNull()
    expect(modelFitsRuntime('claude-sonnet-5', 'codex')).toBe(false)
    expect(modelFitsRuntime('gpt-6-sol', 'codex')).toBe(true)
    expect(modelFitsRuntime('my-local-model', 'codex')).toBe(true)
  })

  it('r goes to the other agent, or for a mixed group to the one after the first', () => {
    const both = ['claude-code', 'codex'] as const
    expect(switchTarget(['codex'], both)).toBe('claude-code')
    expect(switchTarget(['claude-code', 'claude-code'], both)).toBe('codex')
    expect(switchTarget(['codex', 'claude-code'], both)).toBe('claude-code')
    expect(switchTarget([null], both)).toBeNull()
    expect(switchTarget(['hermes'], both)).toBeNull()
    expect(switchTarget(['codex'], ['codex'])).toBeNull()
  })

  it('r on a role with its own instance re-registers it on the other agent, keeping what fits', async () => {
    reg.registry.remove('reviewer')
    reg.registry.register({
      id: 'reviewer',
      displayName: 'reviewer',
      transport: 'stdio',
      metadata: { registryId: 'claude-code' },
      modelVersion: 'claude-sonnet-5',
      responsibilityNote: 'reviews code',
    })
    reg.registry.block('reviewer')
    const result = await switchRuntime(deps, ['reviewer'], 'codex')
    expect(result).toEqual({
      ok: true,
      message: "Code Reviewer now runs on Codex · model reset to Codex's own for reviewer",
    })
    expect(added).toEqual([['reviewer', 'codex']])
    const r = reg.registry.get('reviewer')!
    expect(r.metadata?.registryId).toBe('codex')
    // A Claude model means nothing to Codex; the rest comes along, blocked too.
    expect(r.modelVersion).toBeNull()
    expect(r.responsibilityNote).toBe('reviews code')
    expect(r.status).toBe('blocked')
    // Same agent, so org.yaml doesn't change.
    expect(readFileSync(orgPath, 'utf-8')).toBe(ORG)
  })

  it('an override that fits the new agent stays', async () => {
    reg.registry.setModelVersion('reviewer', 'my-local-model')
    await switchRuntime(deps, ['reviewer'], 'codex')
    expect(reg.registry.get('reviewer')!.modelVersion).toBe('my-local-model')
  })

  it("when the other agent can't be added, the instance stays as it was", async () => {
    const key = reg.registry.getPublicKey('backend')
    addError = 'Claude Code is not installed'
    const result = await switchRuntime(deps, ['backend'], 'claude-code')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Backend Developer stays as it was: Claude Code is not installed')
    const b = reg.registry.get('backend')!
    expect([b.metadata?.registryId, b.modelVersion]).toEqual(['codex', 'gpt-6-sol'])
    expect(reg.registry.getPublicKey('backend')?.equals(key!)).toBe(true)
  })

  it('r on a role on Claude Code itself moves it to a new Codex instance named after the role', async () => {
    const result = await switchRuntime(deps, ['lead'], 'codex')
    expect(result).toEqual({ ok: true, message: 'Tech Lead (now lead) now runs on Codex' })
    expect(added).toEqual([['lead', 'codex']])
    expect(org().roles.lead?.agent).toBe('lead')
    expect(reg.registry.get('claude-code')).not.toBeNull()
    expect(reg.registry.get('lead')?.metadata?.registryId).toBe('codex')
  })

  it("r on a role sharing an instance moves just that role; the other keeps it", async () => {
    writeFileSync(orgPath, ORG.replace('    agent: frontend\n', '    agent: devops\n'))
    const result = await switchRuntime(deps, ['frontend'], 'claude-code')
    expect(result.ok).toBe(true)
    // `frontend` is still a registered agent (no role uses it): a new name.
    expect(added).toEqual([['frontend-2', 'claude-code']])
    expect(org().roles.frontend?.agent).toBe('frontend-2')
    expect(org().roles.devops?.agent).toBe('devops')
    expect(reg.registry.get('devops')?.metadata?.registryId).toBe('codex')
  })

  it('r on a department switches every role in it; a shared instance moves once', async () => {
    const result = await switchRuntime(deps, ['lead', 'reviewer'], 'codex')
    expect(result.ok).toBe(true)
    expect(result.message).toBe('Code Reviewer and Tech Lead (now lead) now run on Codex')
    expect(added.sort()).toEqual([
      ['lead', 'codex'],
      ['reviewer', 'codex'],
    ])
    const rows = teamTree(org(), pageAgents(reg.registry), new Set(), DEFAULTS)
    const eng = rows.find((r) => r.kind === 'department' && r.key === 'engineering')!
    expect(eng.kind === 'department' && eng.runsOn).toBe('Codex')
  })

  it('m sets and clears the model of the agents filling the roles, and a role\'s own model: follows', async () => {
    writeFileSync(orgPath, ORG.replace('    agent: frontend\n', '    agent: frontend\n    model: gpt-6-luna\n'))
    let result = await setRolesModel(deps, ['frontend'], 'gpt-6-astra')
    expect(result).toEqual({ ok: true, message: 'Frontend Developer: model gpt-6-astra' })
    expect(reg.registry.get('frontend')!.modelVersion).toBe('gpt-6-astra')
    expect(org().roles.frontend?.model).toBe('gpt-6-astra')
    result = await setRolesModel(deps, ['frontend'], null)
    expect(result).toEqual({ ok: true, message: "Frontend Developer: back to the agent's own model" })
    expect(reg.registry.get('frontend')!.modelVersion).toBeNull()
    expect(org().roles.frontend?.model).toBeUndefined()
  })

  it('m on a department sets all of it; an unregistered role is skipped', async () => {
    const result = await setRolesModel(deps, ['chores', 'lead'], 'claude-sonnet-5')
    expect(result).toEqual({ ok: true, message: 'Tech Lead: model claude-sonnet-5 · skipped chores (not registered)' })
    const it = await setRolesModel(deps, ['backend', 'frontend', 'devops'], 'gpt-6-sol')
    expect(it.ok).toBe(true)
    expect(['backend', 'frontend', 'devops'].map((id) => reg.registry.get(id)!.modelVersion)).toEqual([
      'gpt-6-sol',
      'gpt-6-sol',
      'gpt-6-sol',
    ])
  })

  it('a typed model must look like one', async () => {
    expect(checkModelId(' gpt-6-sol ')).toEqual({ model: 'gpt-6-sol' })
    expect(checkModelId('claude-opus-4[1m]')).toEqual({ model: 'claude-opus-4[1m]' })
    expect(checkModelId('')).toHaveProperty('error')
    expect(checkModelId('rm -rf /')).toHaveProperty('error')
    expect(checkModelId('gpt\u001b[31m')).toHaveProperty('error')
    const result = await setRolesModel(deps, ['backend'], 'two words')
    expect(result.ok).toBe(false)
    expect(reg.registry.get('backend')!.modelVersion).toBe('gpt-6-sol')
  })

  it('says which other roles share the agent (their model changes too)', () => {
    expect(sharingRoles(parseOrgText(ORG.replace('    agent: chores\n', '    agent: claude-code\n')), ['lead'])).toEqual(['Chores'])
    expect(sharingRoles(parseOrgText(ORG), ['lead'])).toEqual([])
  })
})

// --- The page ---------------------------------------------------------------

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ESC = '\u001B'
const UP = '\u001B[A'
const DOWN = '\u001B[B'
const RIGHT = '\u001B[C'
const LEFT = '\u001B[D'

/** A terminal of `columns` × `rows` (ink-testing-library's has no rows). */
class Stdout extends EventEmitter {
  frames: string[] = []
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super()
  }
  write = (frame: string): void => {
    this.frames.push(frame)
  }
}

class Stdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write = (data: string): void => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

describe('Team page by department', () => {
  let dir: string
  let orgPath: string
  let reg: ReturnType<typeof newRegistry>
  let added: [string, string][]
  let removed: string[]
  let audit: { type: string; payload: Record<string, unknown> }[]
  let instance: Instance
  let stdin: Stdin
  let stdout: Stdout

  const frame = (): string => strip(stdout.frames.at(-1) ?? '')
  const until = async (text: string | RegExp): Promise<string> => {
    for (let i = 0; i < 150; i++) {
      const f = frame()
      if (typeof text === 'string' ? f.includes(text) : text.test(f)) return f
      await tick(20)
    }
    throw new Error(`timed out waiting for ${String(text)}; frame:\n${frame()}`)
  }
  const press = async (key: string): Promise<void> => {
    stdin.write(key)
    await tick(40)
  }
  const org = () => parseOrgText(readFileSync(orgPath, 'utf-8'))

  const mount = async (cols = 120, rows = 44): Promise<void> => {
    stdout = new Stdout(cols, rows)
    stdin = new Stdin()
    const { db } = reg
    const bus = new EventBus<ForemanEventMap>()
    instance = inkRender(
      React.createElement(App, {
        bootInfo: { publicKey: Buffer.alloc(32, 1), policyRules: 3, dbPath: ':memory:', gateway: { stdio: true }, version: '0.0.0-test' },
        services: {
          db,
          sqlite: reg.sqlite,
          bus,
          registry: reg.registry,
          inbox: new InboxService(db, bus),
          keySettleMs: 0,
          orgConfigPath: orgPath,
          audit: { logEvent: (type: string, payload: unknown) => audit.push({ type, payload: payload as Record<string, unknown> }) },
          addTeamAgent: async (id: string, runsOn: string) => {
            added.push([id, runsOn])
            reg.registry.register({ id, displayName: id, transport: 'stdio', metadata: { registryId: runsOn } })
            return null
          },
          removeTeamAgent: async (id: string) => {
            removed.push(id)
            reg.registry.remove(id)
            return null
          },
          agentDefaultModel: (runtime: string) => DEFAULTS[runtime] ?? null,
        },
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new Stdout(cols, rows) as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
    await tick()
    stdin.write(' ') // past the boot splash
    await tick(100)
    stdin.write('t')
    await until('Tech Lead')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-team-departments-'))
    orgPath = join(dir, 'org.yaml')
    writeFileSync(orgPath, ORG)
    reg = newRegistry()
    added = []
    removed = []
    audit = []
  })
  afterEach(() => {
    instance?.unmount()
    reg.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('shows roles under their departments with runtime and model, one line each', async () => {
    await mount()
    const f = frame()
    expect(f).toContain('6 roles in 2 departments')
    expect(f).toContain('▾ Engineering · 2 roles · led by Tech Lead · Claude Code')
    expect(f).toContain('▾ IT · 3 roles · led by Backend Developer · Codex')
    expect(f).toContain('▾ No department · 1 role')
    const line = (title: string): string => f.split('\n').find((l) => l.includes(title) && l.includes('│ '))!
    expect(line('Backend Developer (lead)')).toMatch(/└─ Backend Developer \(lead\)\s+backend\s+Codex\s+gpt-6-sol \(set here\)/)
    expect(line('Frontend Developer')).toMatch(/├─ Frontend Developer\s+frontend\s+Codex\s+gpt-6-luna \(Codex's setting\)/)
    expect(line('Tech Lead (lead)')).toMatch(/Tech Lead \(lead\)\s+lead\s+Claude Code\s+default model/)
    expect(line('Chores')).toMatch(/Chores\s+chores\s+not registered\s+—/)
    // The cursor starts on the first role, with its keys.
    expect(f).toMatch(/❯ +└─ Tech Lead/)
    expect(f).toContain('[x] remove · [r] → Codex · [m] model')
  })

  it('rows fit an 80-column terminal', async () => {
    await mount(80, 44)
    for (const l of frame().split('\n')) expect(displayWidth(l)).toBeLessThanOrEqual(80)
    expect(frame()).toMatch(/├─ Frontend Developer\s+frontend\s+Codex\s+gpt-6-luna \(Codex's/)
    // The model picker and a question fit too.
    await press(DOWN)
    await press(DOWN)
    await press('m')
    await until('model for 3 IT roles')
    for (const l of frame().split('\n')) expect(displayWidth(l)).toBeLessThanOrEqual(80)
    await press(ESC)
    await press('r')
    await until('Switch 3 IT roles to Claude Code? y / n')
    for (const l of frame().split('\n')) expect(displayWidth(l)).toBeLessThanOrEqual(80)
  })

  it('←/→ and Enter fold a department; Enter on a role shows it all; Esc goes back', async () => {
    await mount()
    await press(LEFT) // Tech Lead → Engineering's header
    let f = await until('❯ ▾ Engineering')
    expect(f).toContain('[←→] fold · [x] remove Engineering · [r] all of Engineering → Codex · [m] model for all of Engineering')
    await press(LEFT)
    f = await until('❯ ▸ Engineering')
    expect(f).not.toContain('└─ Code Reviewer')
    await press(RIGHT)
    await until('Code Reviewer')
    await press('\r')
    await until('❯ ▸ Engineering')
    await press('\r')
    await until('❯ ▾ Engineering')
    await press(DOWN)
    await press(DOWN)
    await press('\r')
    f = await until('Its reports')
    expect(f).toContain('Team  Code Reviewer')
    expect(f).toMatch(/Reports to\s+Tech Lead/)
    expect(f).toMatch(/Runs as\s+reviewer · Claude Code \(its own instance\)/)
    expect(f).toMatch(/May\s+read files/)
    await press(ESC)
    await until(/❯ +└─ Code Reviewer/)
    await press(UP)
    await until(/❯ +└─ Tech Lead/)
  })

  it('x asks first; n keeps the role, y removes it and re-points its reports', async () => {
    await mount()
    for (let i = 0; i < 3; i++) await press(DOWN) // from Tech Lead: Reviewer, IT, Backend
    await until(/❯ +└─ Backend Developer/)
    await press('x')
    await until('Remove Backend Developer? y / n')
    // `n` is "no" here, not the Inbox.
    await press('n')
    await until(/❯ +└─ Backend Developer/)
    expect(org().roles.backend).toBeDefined()
    await press('x')
    await until('Remove Backend Developer? y / n')
    await press('y')
    const f = await until('✓ Backend Developer removed')
    expect(f).toContain('Frontend Developer leads IT')
    expect(f).toContain('IT · 2 roles · led by Frontend Developer')
    expect(org().departments.it?.head).toBe('frontend')
    expect(org().roles.devops?.reports_to).toBe('frontend')
    expect(removed).toEqual(['backend'])
    expect(audit).toContainEqual({
      type: 'team_changed',
      payload: expect.objectContaining({ action: 'remove', roles: ['backend'], ok: true }),
    })
  })

  it('r switches a role between Claude Code and Codex at once', async () => {
    await mount()
    await press(DOWN) // Code Reviewer, its own Claude Code instance
    await until(/❯ +└─ Code Reviewer/)
    await press('r')
    await until('✓ Code Reviewer now runs on Codex')
    expect(reg.registry.get('reviewer')?.metadata?.registryId).toBe('codex')
    expect(added).toEqual([['reviewer', 'codex']])
    await until(/Code Reviewer\s+reviewer\s+Codex\s+gpt-6-luna \(Codex's setting\)/)
    // Tech Lead runs on Claude Code itself: it gets its own Codex.
    await press(UP)
    await press('r')
    await until('✓ Tech Lead (now lead) now runs on Codex')
    expect(org().roles.lead?.agent).toBe('lead')
  })

  it('m picks a model: the agent’s own, the usual ones, or a typed one', async () => {
    await mount()
    for (let i = 0; i < 4; i++) await press(DOWN) // from Tech Lead to Frontend Developer
    await until(/❯ +├─ Frontend Developer/)
    await press('m')
    let f = await until('model for Frontend Developer')
    expect(f).toContain("now: gpt-6-luna (Codex's setting)")
    expect(f).toMatch(/❯ Default \(Codex's own setting\)\s+gpt-6-luna/)
    expect(f).toMatch(/gpt-6-luna\s+fast, cheapest/)
    expect(f).toMatch(/gpt-6-sol\s+balanced/)
    expect(f).toMatch(/gpt-6-astra\s+most capable/)
    expect(f).toContain('Type a model…')
    await press(DOWN)
    await press(DOWN)
    await press('\r')
    await until('✓ Frontend Developer: model gpt-6-sol')
    expect(reg.registry.get('frontend')?.modelVersion).toBe('gpt-6-sol')
    await until(/Frontend Developer\s+frontend\s+Codex\s+gpt-6-sol \(set here\)/)
    // Type one: a bad one is refused in words, a good one is set.
    await press('m')
    await until('model for Frontend Developer')
    for (let i = 0; i < 4; i++) await press(DOWN)
    await press('\r')
    await until('A model id the agent knows')
    for (const ch of 'two words') await press(ch)
    await press('\r')
    f = await until('A model id is one word')
    expect(reg.registry.get('frontend')?.modelVersion).toBe('gpt-6-sol')
    await press(ESC) // back to the list of models
    await until('Type a model…')
    await press(ESC)
    await until(/❯ +├─ Frontend Developer/)
    // Back to the agent's own.
    await press('m')
    await until('model for Frontend Developer')
    await press('\r')
    await until("✓ Frontend Developer: back to the agent's own model")
    expect(reg.registry.get('frontend')?.modelVersion).toBeNull()
  })

  it('on a department header: r and m ask first, then act on all its roles; x removes it', async () => {
    await mount()
    for (let i = 0; i < 2; i++) await press(DOWN)
    await until('❯ ▾ IT')
    await press('r')
    await until('Switch 3 IT roles to Claude Code? y / n')
    await press('y')
    await until('✓ Backend Developer, Frontend Developer and DevOps Engineer now run on Claude Code')
    expect(['backend', 'frontend', 'devops'].map((id) => reg.registry.get(id)?.metadata?.registryId)).toEqual([
      'claude-code',
      'claude-code',
      'claude-code',
    ])
    await until('IT · 3 roles · led by Backend Developer · Claude Code')
    await press('m')
    let f = await until('model for 3 IT roles')
    expect(f).toContain("Default (Claude Code's own setting)")
    expect(f).toContain('claude-sonnet-5')
    await press(DOWN)
    await press(DOWN)
    await press('\r')
    await until('Set claude-sonnet-5 for 3 IT roles? y / n')
    await press('y')
    await until('✓ Backend Developer, Frontend Developer and DevOps Engineer: model claude-sonnet-5')
    expect(reg.registry.get('devops')?.modelVersion).toBe('claude-sonnet-5')
    await press('x')
    await until('Remove IT and its 3 roles? y / n')
    await press(ESC)
    await until('❯ ▾ IT')
    expect(org().departments.it).toBeDefined()
    await press('x')
    await press('y')
    f = await until('✓ IT removed (3 roles)')
    expect(f).toContain('3 roles in 1 department')
    expect(org().departments.it).toBeUndefined()
    expect(removed.sort()).toEqual(['backend', 'devops', 'frontend'])
  })

  it('an error shows in words, never a stack', async () => {
    await mount()
    // org.yaml changes under the page to something that doesn't parse.
    writeFileSync(orgPath, `${ORG}\n  broken: [`)
    await press('x')
    await until('Remove Tech Lead? y / n')
    await press('y')
    const f = await until("✗ Couldn't read org.yaml")
    expect(f).not.toMatch(/\bat .*\.(ts|js):\d+/)
  })

  it('m warns when the agent fills other roles too', async () => {
    writeFileSync(orgPath, ORG.replace('    agent: chores\n', '    agent: claude-code\n'))
    await mount()
    await press('m')
    const f = await until('model for Tech Lead')
    expect(f).toContain('claude-code also runs Chores: the model changes there too.')
  })

  it('r with only Claude Code set up says what to add', async () => {
    reg.registry.remove('codex')
    await mount()
    expect(frame()).not.toContain('[r]')
    await press('r')
    await until('✗ Only Claude Code is set up: add codex first (foreman agent add codex).')
    expect(added).toEqual([])
  })

  it('x and m do nothing to Home: letters stay on the Team page', async () => {
    await mount()
    await press('m')
    await until('model for Tech Lead')
    await press(ESC)
    await until(/❯ +└─ Tech Lead/)
    expect(frame()).toContain('Team')
  })
})
