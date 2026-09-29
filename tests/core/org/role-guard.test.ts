import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseOrgText } from '../../../src/core/org/org.js'
import { ROLE_PRESETS } from '../../../src/core/org/role-library.js'
import { capabilityOf, createRoleGuard, roleRefusal } from '../../../src/core/org/role-guard.js'

// Role permissions (org.yaml `can`): what a role's agent may do with its
// own tools, checked by the mediator before policy.

const ORG = `version: 1
company: Acme
roles:
  reviewer:
    title: Code Reviewer
    agent: reviewer
    reports_to: human
    can: [read]
  writer:
    title: Content Writer
    agent: writer
    reports_to: human
    can: [read, write]
  researcher:
    title: Researcher
    agent: multi
    reports_to: human
    can: [read, network]
  analyst:
    title: Analyst
    agent: multi
    reports_to: human
    can: [read, shell]
  mute:
    title: Mute
    agent: mute
    reports_to: human
    can: []
  free:
    title: Free
    agent: free
    reports_to: human
  lead:
    title: Lead
    agent: lead
    reports_to: human
    can: [read]
  lead-free:
    title: Lead too
    agent: lead
    reports_to: human
`

describe('role permissions', () => {
  const org = parseOrgText(ORG)

  it('maps tools to the four families and leaves the rest to policy', () => {
    expect(capabilityOf('read_file')).toBe('read')
    expect(capabilityOf('file_write')).toBe('write')
    expect(capabilityOf('edit_file')).toBe('write')
    expect(capabilityOf('shell_exec')).toBe('shell')
    expect(capabilityOf('web_fetch')).toBe('network')
    for (const t of ['org_post', 'submit_command', 'github.create_issue', undefined]) expect(capabilityOf(t)).toBeNull()
  })

  it('refuses what the role may not do, with the reason', () => {
    expect(roleRefusal(org, 'reviewer', 'read_file')).toBeNull()
    expect(roleRefusal(org, 'reviewer', 'file_write')).toBe(
      'Code Reviewer (reviewer) may not write files: this role may only read files (org.yaml `can`)',
    )
    expect(roleRefusal(org, 'writer', 'shell_exec')).toMatch(/may not run shell commands: this role may only read files, write files/)
    expect(roleRefusal(org, 'writer', 'org_post')).toBeNull()
    expect(roleRefusal(org, 'mute', 'read_file')).toMatch(/has no tool permissions/)
  })

  it('holds an unverified source claiming the agent, ignoring case', () => {
    expect(roleRefusal(org, 'untrusted:reviewer', 'file_write')).not.toBeNull()
    expect(roleRefusal(org, 'Reviewer', 'shell_exec')).not.toBeNull()
  })

  it('an agent in several roles may do what any of them may; a role without `can` lifts the limit', () => {
    expect(roleRefusal(org, 'multi', 'web_fetch')).toBeNull()
    expect(roleRefusal(org, 'multi', 'shell_exec')).toBeNull()
    expect(roleRefusal(org, 'multi', 'file_write')).not.toBeNull()
    expect(roleRefusal(org, 'lead', 'shell_exec')).toBeNull()
    expect(roleRefusal(org, 'free', 'shell_exec')).toBeNull()
    expect(roleRefusal(org, 'nobody', 'shell_exec')).toBeNull()
    expect(roleRefusal(null, 'reviewer', 'shell_exec')).toBeNull()
  })

  it('every ready-made role is valid in org.yaml', () => {
    const roles = ROLE_PRESETS.map(
      (p) => `  ${p.id}:\n    title: ${p.title}\n    agent: ${p.id}\n    reports_to: human\n    instructions: ${JSON.stringify(p.instructions)}\n    can: [${p.can.join(', ')}]\n`,
    ).join('')
    expect(() => parseOrgText(`version: 1\ncompany: Acme\nroles:\n${roles}`)).not.toThrow()
    expect(() => parseOrgText(ORG.replace('can: [read]', 'can: [read, sudo]'))).toThrow()
  })
})

describe('createRoleGuard', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-role-guard-'))
    path = join(dir, 'org.yaml')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const rewrite = (text: string, secondsAhead: number): void => {
    writeFileSync(path, text)
    const t = new Date(Date.now() + secondsAhead * 1000)
    utimesSync(path, t, t)
  }

  it('limits nothing without org.yaml and follows edits', () => {
    const guard = createRoleGuard(path)
    expect(guard('reviewer', 'file_write')).toBeNull()
    rewrite(ORG, 1)
    expect(guard('reviewer', 'file_write')).toMatch(/may not write files/)
    rewrite(ORG.replace('    can: [read]\n  writer', '    can: [read, write]\n  writer'), 2)
    expect(guard('reviewer', 'file_write')).toBeNull()
  })

  it('fails closed on a broken org.yaml that sets `can`, and only for the four families', () => {
    rewrite(`${ORG}  broken: [\n`, 1)
    const guard = createRoleGuard(path)
    expect(guard('free', 'read_file')).toMatch(/doesn't parse/)
    expect(guard('anyone', 'shell_exec')).toMatch(/foreman org validate/)
    expect(guard('anyone', 'org_post')).toBeNull()
  })

  it('a broken org.yaml without `can` limits nothing, as before', () => {
    rewrite(`${ORG.replace(/^\s*can:.*\n/gm, '')}  broken: [\n`, 1)
    expect(createRoleGuard(path)('reviewer', 'file_write')).toBeNull()
  })
})
