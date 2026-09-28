import { describe, expect, it } from 'vitest'
import {
  findIntegration,
  IntegrationCatalogError,
  loadBundledIntegrationCatalog,
  parseIntegrationCatalogText,
  validateIntegrationCatalog,
  type CatalogValidationContext,
  type IntegrationCatalog,
} from '../../../src/core/integrations/catalog.js'
import { renderIntegration, applyToolOverride } from '../../../src/core/integrations/render.js'
import { findCatalogEntry, loadBundledMcpCatalog } from '../../../src/core/mcp-hub/catalog.js'
import { toolRuleLevel } from '../../../src/core/mcp-hub/config.js'
import { loadBundledRegistry } from '../../../src/core/registry-catalog.js'
import { redactSecretShapes } from '../../../src/core/risk-rules/secret-patterns.js'

const mcp = loadBundledMcpCatalog()
const ctx: CatalogValidationContext = {
  mcp,
  agentIds: new Set(loadBundledRegistry().agents.map((a) => a.id)),
}
const bundled = loadBundledIntegrationCatalog(ctx)

/** The bundled catalog with one integration changed. */
function mutate(id: string, fn: (e: IntegrationCatalog['integrations'][number]) => void): IntegrationCatalog {
  const doc = structuredClone(bundled)
  fn(doc.integrations.find((e) => e.id === id)!)
  return doc
}
const issues = (doc: IntegrationCatalog): string[] =>
  validateIntegrationCatalog(doc, ctx).map((i) => `${i.path}: ${i.message}`)

describe('bundled integration catalog', () => {
  it('covers the launch products and passes every cross-catalog rule', () => {
    expect(bundled.integrations.map((e) => e.id).sort()).toEqual(
      ['atlassian', 'github', 'gitlab', 'linear', 'notion', 'trello'].sort(),
    )
    expect(validateIntegrationCatalog(bundled, ctx)).toEqual([])
  })

  it('resolves ids and aliases case-insensitively', () => {
    expect(findIntegration(bundled, 'JIRA')?.id).toBe('atlassian')
    expect(findIntegration(bundled, 'gh')?.id).toBe('github')
    expect(findIntegration(bundled, 'nope')).toBeNull()
  })

  it('ships no raw credentials (format hints and patterns only)', () => {
    expect(redactSecretShapes(JSON.stringify(bundled)).count).toBe(0)
  })

  it('keeps GitHub in lockdown, merges on confirm and reads allowed', () => {
    const server = findCatalogEntry(mcp, 'github')!
    expect(server.headers['X-MCP-Lockdown']).toBe('true')
    expect(toolRuleLevel(server.tools, 'merge_pull_request')).toBe('confirm')
    expect(toolRuleLevel(server.tools, 'issue_read')).toBe('allow')
    expect(toolRuleLevel(server.tools, 'mark_all_notifications_read')).not.toBe('allow')
  })
})

describe('catalog validation rules', () => {
  it('rejects a variant pointing at an unknown server', () => {
    const doc = mutate('github', (e) => void (e.variants[0]!.server = 'no-such-server'))
    expect(issues(doc).join('\n')).toMatch(/no server 'no-such-server'/)
  })

  it('rejects oauth on a server that does not sign in with oauth', () => {
    const doc = mutate('github', (e) => void (e.variants[0]!.auth = { kind: 'oauth' }))
    expect(issues(doc).join('\n')).toMatch(/oauth needs an http server with `auth: oauth`/)
  })

  it('rejects a secret field the server does not declare, and a declared secret nobody asks for', () => {
    const doc = mutate('github', (e) => {
      const auth = e.variants[0]!.auth
      if (auth.kind === 'secrets') auth.fields[0]!.secret = 'other-token'
    })
    const text = issues(doc).join('\n')
    expect(text).toMatch(/secret 'other-token' is not declared/)
    expect(text).toMatch(/needs secret 'github-pat', which the variant never asks for/)
  })

  it('rejects allow/ask wildcards', () => {
    const doc = mutate('linear', (e) => void (e.variants[0]!.access_levels['read-write']!.tools.allow = ['*']))
    expect(issues(doc).join('\n')).toMatch(/'\*' matches every tool/)
  })

  it('rejects credentials or URL changes in an access level', () => {
    const doc = mutate('linear', (e) => {
      e.variants[1]!.access_levels['read-only']!.headers = { Authorization: 'Bearer x' }
    })
    expect(issues(doc).join('\n')).toMatch(/credentials come from the server entry/)
  })

  it('rejects duplicate aliases across integrations and unknown agents', () => {
    const doc = mutate('linear', (e) => {
      e.aliases = ['gh']
      e.used_by_agents = ['not-an-agent']
    })
    const text = issues(doc).join('\n')
    expect(text).toMatch(/'gh' is already used by integration 'github'/)
    expect(text).toMatch(/unknown agent 'not-an-agent'/)
  })

  it('rejects variants without a read-only level or with two recommended', () => {
    const doc = mutate('linear', (e) => {
      delete e.variants[0]!.access_levels['read-only']
      e.variants[0]!.default_access_level = 'read-write'
      e.variants[1]!.recommended = true
    })
    const text = issues(doc).join('\n')
    expect(text).toMatch(/every variant needs a read-only level/)
    expect(text).toMatch(/exactly one variant must be recommended/)
  })

  it('reports schema errors with their path', () => {
    try {
      parseIntegrationCatalogText(JSON.stringify({ version: 1, integrations: [{ id: 'x' }] }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationCatalogError)
      expect((err as IntegrationCatalogError).issues.length).toBeGreaterThan(0)
    }
  })
})

// =============================================================================
// Rendering: four layers unioned, deny > confirm > ask > allow
// =============================================================================

describe('renderIntegration', () => {
  const render = (id: string, variant: string, extra: Partial<Parameters<typeof renderIntegration>[0]> = {}) => {
    const entry = bundled.integrations.find((e) => e.id === id)!
    const v = entry.variants.find((x) => x.id === variant)!
    return renderIntegration({
      entry,
      variant: v,
      server: findCatalogEntry(mcp, v.server)!,
      accessLevel: 'read-only',
      ...extra,
    })
  }

  it('read-only denies GitHub writes that read-write only asks for', () => {
    const ro = render('github', 'official')
    const rw = render('github', 'official', { accessLevel: 'read-write' })
    expect(toolRuleLevel(ro.server.tools!, 'issue_write')).toBe('deny')
    expect(toolRuleLevel(rw.server.tools!, 'issue_write')).not.toBe('deny')
    expect(toolRuleLevel(rw.server.tools!, 'merge_pull_request')).toBe('confirm')
    expect(ro.server.headers!.Authorization).toBe('Bearer ${secret:github-pat}')
  })

  it('renames secrets for a second account without touching the slot', () => {
    const out = render('github', 'official', { secretNames: { 'github-pat': 'github-pat-work' } })
    expect(out.server.headers!.Authorization).toBe('Bearer ${secret:github-pat-work}')
    expect(out.secrets).toEqual({ 'github-pat': 'github-pat-work' })
  })

  it('refuses reserved or notification-looking secret names and unknown slots', () => {
    expect(() => render('github', 'official', { secretNames: { 'github-pat': 'mcp-oauth-github' } })).toThrow()
    expect(() => render('github', 'official', { secretNames: { 'nope': 'x' } })).toThrow(/has no secret 'nope'/)
  })

  it('denies the tools of products left out, cross-product tools included', () => {
    const all = render('atlassian', 'official')
    const jiraOnly = render('atlassian', 'official', { products: ['jira'] })
    expect(all.products).toBeUndefined()
    expect(jiraOnly.products).toEqual(['jira'])
    const atlassian = bundled.integrations.find((e) => e.id === 'atlassian')!
    const confluenceTool = atlassian.products.find((p) => p.id === 'confluence')!.tools[0]!
    expect(toolRuleLevel(jiraOnly.server.tools!, confluenceTool)).toBe('deny')
    for (const tool of atlassian.cross_product_tools) {
      expect(toolRuleLevel(jiraOnly.server.tools!, tool.replace('*', 'x'))).toBe('deny')
    }
    expect(() => render('atlassian', 'official', { products: ['bitbucket'] })).toThrow(/no product 'bitbucket'/)
  })

  it('lets an override tighten but never lift a catalog deny or confirm', () => {
    let overrides = applyToolOverride({}, 'merge_pull_request', 'allow')
    overrides = applyToolOverride(overrides, 'get_me', 'deny')
    const out = render('github', 'official', { accessLevel: 'read-write', toolOverrides: overrides })
    expect(toolRuleLevel(out.server.tools!, 'merge_pull_request')).toBe('confirm')
    expect(toolRuleLevel(out.server.tools!, 'get_me')).toBe('deny')
    expect(out.ignoredOverrides).toContainEqual({ tool: 'merge_pull_request', wanted: 'allow', effective: 'confirm' })
    expect(applyToolOverride(overrides, 'get_me', 'default')).toEqual({ allow: ['merge_pull_request'] })
    expect(() => applyToolOverride({}, 'get_*', 'allow')).toThrow(/not a tool name/)
  })

  it('fills the GitLab host and still refuses a smuggled one', () => {
    expect(render('gitlab', 'official', { params: { host: 'git.example.com' } }).server.url).toBe(
      'https://git.example.com/api/v4/mcp',
    )
    expect(() => render('gitlab', 'official', { params: { host: 'gitlab.com@evil.com' } })).toThrow()
  })
})
