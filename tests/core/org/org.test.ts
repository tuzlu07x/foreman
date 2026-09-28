import { describe, expect, it } from 'vitest'
import {
  allowedMcpServers,
  buildTree,
  checkDelegation,
  OrgValidationError,
  parseOrgText,
  resolveAssignee,
  validateOrg,
} from '../../../src/core/org/org.js'
import { findOrgTemplate, ORG_TEMPLATES } from '../../../src/core/org/templates.js'

const startup = () => parseOrgText(findOrgTemplate('startup')!.render('Acme'))

describe('org templates', () => {
  it.each(ORG_TEMPLATES.map((t) => t.id))('%s renders a valid org', (id) => {
    const org = parseOrgText(findOrgTemplate(id)!.render('Acme "Robots" Inc.'))
    expect(org.company).toBe('Acme "Robots" Inc.')
    expect(buildTree(org).length).toBeGreaterThan(0)
  })
})

describe('delegation along the chart (startup template)', () => {
  const org = startup()
  // hermes = ceo, claude-code = cto, codex = engineer, openclaw = cmo,
  // zeroclaw = cfo, generic-mcp = support-lead

  it('the human (CLI / owner) may assign to anyone', () => {
    expect(checkDelegation(org, 'cli', 'codex')?.allowed).toBe(true)
  })

  it('managers delegate down, reports escalate up', () => {
    expect(checkDelegation(org, 'claude-code', 'codex')?.allowed).toBe(true)
    expect(checkDelegation(org, 'codex', 'claude-code')?.allowed).toBe(true)
  })

  it('skip_levels lets the CEO reach an engineer directly', () => {
    expect(checkDelegation(org, 'hermes', 'codex')).toMatchObject({ allowed: true })
  })

  it('cross-department work goes through department heads', () => {
    expect(checkDelegation(org, 'claude-code', 'openclaw')?.allowed).toBe(true) // cto ↔ cmo
    const verdict = checkDelegation(org, 'codex', 'openclaw') // engineer → cmo
    expect(verdict?.allowed).toBe(false)
    expect(verdict?.reason).toMatch(/department heads/)
  })

  it('a block keeps the pair’s reason and names the route the chart allows', () => {
    const verdict = checkDelegation(org, 'codex', 'openclaw') // engineer → cmo
    expect(verdict?.reason).toBe(
      'engineer → cmo is outside the reporting chain in org.yaml: cross-department work must go through department heads',
    )
    expect(verdict?.next).toBe("hand it to cto (claude-code), engineer's manager, who can assign it to cmo")
    const isolated = { ...org, delegation: { ...org.delegation, cross_department: 'deny' as const } }
    const denied = checkDelegation(isolated, 'claude-code', 'openclaw') // cto → cmo
    expect(denied?.reason).toContain('departments are isolated')
    expect(denied?.next).toBe("hand it to ceo (hermes), cto's manager, who can assign it to cmo")
    expect(checkDelegation(org, 'claude-code', 'codex')?.next).toBeUndefined()
  })

  it('has no opinion about agents outside the chart', () => {
    expect(checkDelegation(org, 'codex', 'some-other-agent')).toBeNull()
  })

  it('isolated departments block even heads', () => {
    const isolated = { ...org, delegation: { ...org.delegation, cross_department: 'deny' as const } }
    expect(checkDelegation(isolated, 'claude-code', 'openclaw')?.allowed).toBe(false)
  })
})

describe('least-privilege MCP access', () => {
  const org = startup()
  it('grants department servers to members', () => {
    expect([...allowedMcpServers(org, 'codex')!]).toEqual(['github', 'filesystem', 'playwright', 'sentry'])
    expect([...allowedMcpServers(org, 'zeroclaw')!]).toEqual(['stripe'])
  })
  it('matches agent ids case-insensitively, so a spelling change is no way out', () => {
    expect([...allowedMcpServers(org, 'ZeroClaw')!]).toEqual(['stripe'])
    const cased = { ...org, roles: { ...org.roles, cfo: { ...org.roles.cfo!, agent: 'ZeroClaw' } } }
    expect([...allowedMcpServers(cased, 'zeroclaw')!]).toEqual(['stripe'])
    expect(checkDelegation(cased, 'zeroclaw', 'codex')?.allowed).toBe(false)
  })
  it('leaves roles without a list (and non-members) unrestricted', () => {
    expect(allowedMcpServers(org, 'hermes')).toBeNull() // ceo has no department
    expect(allowedMcpServers(org, 'not-in-org')).toBeNull()
  })
})

describe('assignment targets', () => {
  const org = startup()
  it('resolves roles, departments (→ head) and agent ids', () => {
    expect(resolveAssignee(org, 'engineer')).toBe('engineer')
    expect(resolveAssignee(org, 'marketing')).toBe('cmo')
    expect(resolveAssignee(org, 'codex')).toBe('engineer')
    expect(resolveAssignee(org, 'nobody')).toBeNull()
  })
})

describe('structural validation', () => {
  it('rejects reporting cycles', () => {
    expect(() =>
      parseOrgText(`version: 1
company: X
roles:
  a: { title: A, agent: codex, reports_to: b }
  b: { title: B, agent: hermes, reports_to: a }
  c: { title: C, agent: hermes, reports_to: human }
`),
    ).toThrow(/cycle/)
  })

  it('rejects unknown managers, departments and heads outside their department', () => {
    const bad = () =>
      parseOrgText(`version: 1
company: X
departments:
  eng: { name: Eng, head: lead }
roles:
  lead: { title: Lead, agent: codex, reports_to: nobody }
`)
    expect(bad).toThrow(OrgValidationError)
    try {
      bad()
    } catch (err) {
      const messages = (err as OrgValidationError).issues.map((i) => i.message).join('\n')
      expect(messages).toMatch(/unknown role 'nobody'/)
      expect(messages).toMatch(/must belong to that department/)
    }
  })

  it('warns (not errors) about unregistered agents and shared agents', () => {
    const org = startup()
    const issues = validateOrg(org, new Set(['hermes', 'codex']))
    expect(issues.every((i) => i.level === 'warning')).toBe(true)
    expect(issues.some((i) => i.message.includes("'claude-code'"))).toBe(true)
  })
})
