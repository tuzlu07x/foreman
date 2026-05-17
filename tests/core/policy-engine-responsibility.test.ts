import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createInMemoryDb } from '../../src/db/client.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'

// =============================================================================
// Tests for #299 — responsibility_policies schema in policy.yaml
// =============================================================================
//
// Pin the parser + the loader's persistence semantics. The risk rule that
// consumes this schema lands in #300; here we only verify load → snapshot.

describe('PolicyEngine — responsibility_policies', () => {
  let handle: ReturnType<typeof createInMemoryDb>
  let engine: PolicyEngine

  beforeEach(() => {
    handle = createInMemoryDb()
    engine = new PolicyEngine(handle.db)
  })

  afterEach(() => {
    handle.sqlite.close()
  })

  it('returns an empty list when the policy doc has no responsibility_policies', () => {
    engine.loadYamlText('rules: []\n')
    expect(engine.getResponsibilityPolicies()).toEqual([])
  })

  it('parses a single responsibility policy with all field kinds', () => {
    engine.loadYamlText(`
responsibility_policies:
  - responsibility: "code writing"
    cannot_access:
      - "/\\\\.ssh/"
      - "/\\\\.aws/"
    can_call_agents_with_responsibility:
      - "code review"
    cannot_call_agents_with_responsibility:
      - "payment processing"
    can_use_services:
      - github
`)
    const policies = engine.getResponsibilityPolicies()
    expect(policies).toHaveLength(1)
    expect(policies[0]).toMatchObject({
      responsibility: 'code writing',
      cannot_access: ['/\\.ssh/', '/\\.aws/'],
      can_call_agents_with_responsibility: ['code review'],
      cannot_call_agents_with_responsibility: ['payment processing'],
      can_use_services: ['github'],
    })
  })

  it('parses multiple responsibility policies in declaration order', () => {
    engine.loadYamlText(`
responsibility_policies:
  - responsibility: "code writing"
    cannot_access: ["/\\\\.ssh/"]
  - responsibility: "project management"
    can_use_services: [github, jira]
  - responsibility: "document analysis"
    cannot_access: ["(^|/)\\\\.env(\\\\..*)?$"]
`)
    const policies = engine.getResponsibilityPolicies()
    expect(policies.map((p) => p.responsibility)).toEqual([
      'code writing',
      'project management',
      'document analysis',
    ])
  })

  it('accepts a responsibility policy with only one optional field set', () => {
    engine.loadYamlText(`
responsibility_policies:
  - responsibility: "minimal"
    can_use_services: [telegram]
`)
    const [policy] = engine.getResponsibilityPolicies()
    expect(policy?.responsibility).toBe('minimal')
    expect(policy?.cannot_access).toBeUndefined()
    expect(policy?.can_call_agents_with_responsibility).toBeUndefined()
  })

  it('rejects a responsibility entry missing the responsibility field', () => {
    expect(() =>
      engine.loadYamlText(`
responsibility_policies:
  - cannot_access: ["/etc/passwd"]
`),
    ).toThrow()
  })

  it('rejects a responsibility entry with an empty responsibility string', () => {
    expect(() =>
      engine.loadYamlText(`
responsibility_policies:
  - responsibility: ""
    cannot_access: ["/etc/passwd"]
`),
    ).toThrow()
  })

  it('rejects unknown keys at the responsibility entry level (strict schema)', () => {
    expect(() =>
      engine.loadYamlText(`
responsibility_policies:
  - responsibility: "code writing"
    forbidden_field: ["x"]
`),
    ).toThrow()
  })

  it('survives YAML reload — replaces previous snapshot in place', () => {
    engine.loadYamlText(`
responsibility_policies:
  - responsibility: "old role"
    cannot_access: ["/old"]
`)
    expect(engine.getResponsibilityPolicies()).toHaveLength(1)

    engine.loadYamlText(`
responsibility_policies:
  - responsibility: "new role"
    cannot_access: ["/new"]
  - responsibility: "another"
    can_use_services: [github]
`)
    const after = engine.getResponsibilityPolicies()
    expect(after).toHaveLength(2)
    expect(after.map((p) => p.responsibility)).toEqual([
      'new role',
      'another',
    ])
  })

  it('reload with no responsibility_policies clears the previous list', () => {
    engine.loadYamlText(`
responsibility_policies:
  - responsibility: "old"
    cannot_access: ["/x"]
`)
    expect(engine.getResponsibilityPolicies()).toHaveLength(1)
    engine.loadYamlText('rules: []\n')
    expect(engine.getResponsibilityPolicies()).toEqual([])
  })

  it('returned snapshot is a shallow copy — caller mutations do not affect engine state', () => {
    engine.loadYamlText(`
responsibility_policies:
  - responsibility: "code writing"
    cannot_access: ["/\\\\.ssh/"]
`)
    const first = engine.getResponsibilityPolicies()
    first[0]!.responsibility = 'MUTATED'
    const second = engine.getResponsibilityPolicies()
    expect(second[0]!.responsibility).toBe('code writing')
  })

  it('default policy template loads cleanly and exposes the starter set', async () => {
    const { DEFAULT_POLICY_YAML } = await import(
      '../../src/cli/policy-template.js'
    )
    engine.loadYamlText(DEFAULT_POLICY_YAML)
    const policies = engine.getResponsibilityPolicies()
    expect(policies.length).toBeGreaterThanOrEqual(3)
    expect(policies.map((p) => p.responsibility)).toContain('code writing')
    expect(policies.map((p) => p.responsibility)).toContain(
      'project management',
    )
  })
})
