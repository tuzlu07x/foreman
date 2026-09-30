import React from 'react'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { ForemanCommandRouter, registerBuiltinCommands } from '../../src/core/foreman-command.js'
import { InboxService } from '../../src/core/inbox.js'
import { parseOrgText } from '../../src/core/org/org.js'
import { RegistryService } from '../../src/core/registry.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { App } from '../../src/tui/app.js'
import { nextSteps, teamSummary } from '../../src/tui/home-guide.js'
import { canWords, reportsToWords, teamRows } from '../../src/tui/team-page-logic.js'

// The Team page (t), Chat with Foreman (c) and Home's next steps.

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ESC = '\u001B'
const DOWN = '\u001B[B'

const ORG = `version: 1
company: Acme
human:
  title: Founder
departments:
  engineering:
    name: Engineering
    head: lead
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
    instructions: Review diffs and report findings.
    can: [read]
  chores:
    title: Chores
    agent: chores
    reports_to: human
    can: []
`

describe('team rows and Home facts', () => {
  const org = parseOrgText(ORG)

  it('lays the chart out as a tree, with what runs each role and what it may do', () => {
    const rows = teamRows(org, [
      { id: 'claude-code', registryId: 'claude-code' },
      { id: 'reviewer', registryId: 'claude-code' },
    ])
    expect(rows.map((r) => `${r.prefix}${r.roleId}`)).toEqual(['├─ lead', '│  └─ reviewer', '└─ chores'])
    expect(rows.map((r) => [r.runsOn, r.registered, r.department])).toEqual([
      ['Claude Code', true, 'Engineering'],
      ['Claude Code', true, 'Engineering'],
      [null, false, null],
    ])
    expect(canWords(org.roles.reviewer!)).toBe('read files')
    expect(canWords(org.roles.lead!)).toBe('anything policy.yaml allows')
    expect(canWords(org.roles.chores!)).toBe('only talk to colleagues')
    expect(reportsToWords(org, org.roles.reviewer!)).toBe('Tech Lead')
    expect(reportsToWords(org, org.roles.lead!)).toBe('you')
  })

  it('lists only the setup steps still open', () => {
    expect(nextSteps({ agents: 0, chatApp: false, service: false, org: null, orgBroken: false }).map((s) => s.how)).toEqual([
      'foreman agent add claude-code',
      'foreman notify enable telegram',
      'foreman service install',
      't, then n',
    ])
    expect(nextSteps({ agents: 2, chatApp: true, service: null, org, orgBroken: false })).toEqual([])
    expect(teamSummary(org)).toBe('Acme · 3 roles in 1 department')
    expect(teamSummary(null)).toBeNull()
  })
})

describe('Team and Chat pages', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let app: ReturnType<typeof render>
  let dir: string
  let registry: RegistryService
  let added: [string, string][]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-team-page-'))
    writeFileSync(join(dir, 'org.yaml'), ORG)
    ;({ db, sqlite } = createInMemoryDb())
    const bus = new EventBus<ForemanEventMap>()
    registry = new RegistryService(db, bus)
    added = []
    registry.register({ id: 'claude-code', displayName: 'Claude Code', transport: 'stdio', metadata: { registryId: 'claude-code' } })
    registry.register({ id: 'reviewer', displayName: 'reviewer', transport: 'stdio', metadata: { registryId: 'claude-code' } })
    const router = new ForemanCommandRouter()
    registerBuiltinCommands(router)
    app = render(
      React.createElement(App, {
        bootInfo: { publicKey: Buffer.alloc(32, 1), policyRules: 3, dbPath: ':memory:', gateway: { stdio: true }, version: '0.0.0-test' },
        services: {
          db,
          sqlite,
          bus,
          registry,
          inbox: new InboxService(db, bus),
          keySettleMs: 0,
          orgConfigPath: join(dir, 'org.yaml'),
          // The Team page's instances: registered here, nothing installed.
          addTeamAgent: async (id: string, runsOn: string) => {
            added.push([id, runsOn])
            registry.register({ id, displayName: id, transport: 'stdio', metadata: { registryId: runsOn } })
            return null
          },
          commandRouter: router,
          commandContext: { db, registry, llmConfigPath: '/nonexistent/llm.yaml', configDir: '/nonexistent' },
        },
      }),
    )
    await tick()
    app.stdin.write(' ')
    await tick()
  })

  afterEach(() => {
    app.unmount()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('Home shows the team at a glance', () => {
    expect(strip(app.lastFrame())).toContain('Acme · 3 roles in 1 department')
  })

  it('t opens the team: the chart, then a role’s details; n offers ready-made roles and Esc goes back', async () => {
    app.stdin.write('t')
    await tick()
    let frame = strip(app.lastFrame())
    expect(frame).toContain('Team')
    // By department: Engineering's lead, its reviewer under it, then the
    // roles with no department.
    expect(frame).toContain('▾ Engineering · 2 roles · led by Tech Lead · Claude Code')
    expect(frame).toContain('└─ Tech Lead (lead)')
    expect(frame).toContain('   └─ Code Reviewer')
    expect(frame).toContain('▾ No department · 1 role')
    expect(frame).toContain('May: anything policy.yaml allows')
    app.stdin.write(DOWN)
    await tick()
    frame = strip(app.lastFrame())
    expect(frame).toContain('role reviewer · reports to Tech Lead')
    expect(frame).toContain('May: read files')
    expect(frame).toContain('Review diffs and report findings.')
    app.stdin.write('n')
    await tick()
    frame = strip(app.lastFrame())
    expect(frame).toContain('add a role')
    expect(frame).toContain('Researcher')
    expect(frame).toContain('+ Your own role…')
    // `n` here is "add", not the inbox.
    expect(frame).not.toContain('Inbox ·')
    app.stdin.write(ESC)
    await tick()
    app.stdin.write(ESC)
    await tick()
    expect(strip(app.lastFrame())).toContain('Activity')
  })

  it('d adds a department: all its roles at once, on the agent you pick, led by its first role', async () => {
    registry.register({ id: 'codex', displayName: 'Codex', transport: 'stdio', metadata: { registryId: 'codex' } })
    const until = async (text: string): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        const frame = strip(app.lastFrame())
        if (frame.includes(text)) return frame
        await tick(20)
      }
      throw new Error(`timed out waiting for ${JSON.stringify(text)}; frame:\n${strip(app.lastFrame())}`)
    }
    app.stdin.write('t')
    await until('└─ Tech Lead')
    expect(strip(app.lastFrame())).toContain('3 roles in 1 department')
    expect(strip(app.lastFrame())).toContain('leads Engineering')
    app.stdin.write('d')
    let frame = await until('Your own department…')
    expect(frame).toContain('❯ IT')
    expect(frame).toContain('Marketing')
    expect(frame).toContain('Customer Support')
    expect(frame).toContain('Your own department…')
    // `d` here is "add a department", not the Delegations page.
    expect(frame).toContain('Team  add a department')
    app.stdin.write('\r')
    await until('which agent runs IT?')
    await until('❯ Codex')
    app.stdin.write('\u001B[A')
    await until('❯ Claude Code')
    app.stdin.write('\r')
    frame = await until('✓ IT added')
    expect(frame).toContain('6 roles in 2 departments')
    expect(frame).toContain('Backend Developer')
    // ← goes to Engineering's header, ← again folds it: IT's header shows.
    app.stdin.write('\u001B[D')
    await until('❯ ▾ Engineering')
    app.stdin.write('\u001B[D')
    await until('▸ Engineering')
    await until('IT · 3 roles · led by Backend Developer · Claude Code')
    expect(added).toEqual([
      ['backend-developer', 'claude-code'],
      ['frontend-developer', 'claude-code'],
      ['devops-engineer', 'claude-code'],
    ])
    const org = parseOrgText(readFileSync(join(dir, 'org.yaml'), 'utf-8'))
    expect(org.departments.it).toEqual({ name: 'IT', head: 'backend-developer' })
    expect(org.departments.engineering?.head).toBe('lead')
    expect(org.roles['backend-developer']).toMatchObject({ department: 'it', reports_to: 'human' })
    expect(org.roles['frontend-developer']).toMatchObject({ department: 'it', reports_to: 'backend-developer' })
    expect(org.roles['devops-engineer']).toMatchObject({ department: 'it', reports_to: 'backend-developer' })
  })

  it('n offers "+ Add a department…" too, and your own department gets its first role', async () => {
    const until = async (text: string): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        const frame = strip(app.lastFrame())
        if (frame.includes(text)) return frame
        await tick(20)
      }
      throw new Error(`timed out waiting for ${JSON.stringify(text)}; frame:\n${strip(app.lastFrame())}`)
    }
    const type = async (text: string): Promise<void> => {
      await tick(100)
      for (const ch of text) {
        app.stdin.write(ch)
        await tick(5)
      }
      await until(text)
    }
    app.stdin.write('t')
    await until('└─ Tech Lead')
    app.stdin.write('n')
    await until('+ Add a department…')
    app.stdin.write('\u001B[A')
    await until('❯ + Add a department…')
    app.stdin.write('\r')
    await until('add a department')
    app.stdin.write('\u001B[A')
    await until('❯ Your own department…')
    app.stdin.write('\r')
    await until('your own department')
    await type('Sales')
    app.stdin.write('\r')
    // Only Claude Code is registered: no question which agent runs it.
    await until("Sales's first role")
    await type('Closer')
    app.stdin.write('\r')
    await until('What should Closer do?')
    await type('Close deals.')
    app.stdin.write('\r')
    await until('what may Closer do?')
    app.stdin.write('\r')
    await until('✓ Sales added')
    const org = parseOrgText(readFileSync(join(dir, 'org.yaml'), 'utf-8'))
    expect(org.departments.sales).toEqual({ name: 'Sales', head: 'closer' })
    expect(org.roles.closer).toMatchObject({ department: 'sales', reports_to: 'human', instructions: 'Close deals.', can: ['read'] })
    expect(added).toEqual([['closer', 'claude-code']])
  })

  it('c opens a chat with Foreman that takes typed text, and Esc leaves it', async () => {
    app.stdin.write('c')
    await tick()
    expect(strip(app.lastFrame())).toContain('Chat with Foreman')
    // Letters are typed text here, not page hotkeys.
    app.stdin.write('t')
    await tick()
    expect(strip(app.lastFrame())).toContain('Chat with Foreman')
    app.stdin.write(ESC)
    await tick()
    expect(strip(app.lastFrame())).not.toContain('Chat with Foreman')
  })

  it('the mediator test console is still one command away', async () => {
    app.stdin.write(':')
    await tick()
    app.stdin.write('open test')
    await tick()
    app.stdin.write('\r')
    await tick(150)
    expect(strip(app.lastFrame())).toMatch(/test console|Mediator/i)
  })
})
