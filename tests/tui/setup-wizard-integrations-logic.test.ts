import { describe, expect, it } from 'vitest'
import { findIntegration, recommendedVariant, type IntegrationEntry } from '../../src/core/integrations/catalog.js'
import { loadIntegrationCatalogs } from '../../src/core/integrations/wiring.js'
import type { HubConfig, ServerConfig } from '../../src/core/mcp-hub/config.js'
import {
  applyCredentialSubmit,
  applyIntegrationsPickerSubmit,
  buildWizardAddInput,
  configuredIntegrationIds,
  credentialFields,
  credentialProblem,
  describeWizardAccess,
  freshDraft,
  integrationPickerOptions,
  integrationStages,
  nextCommand,
  nextStage,
  paramProblem,
  pendingIntegrations,
  wizardAccess,
} from '../../src/tui/setup-wizard/integrations-logic.js'
import {
  INTEGRATION_MANAGED_SERVICES,
  wizardServiceChoices,
} from '../../src/tui/setup-wizard/services-logic.js'

// =============================================================================
// The setup wizard's optional Integrations step (docs/plans/integrations.md
// §7): pure logic, against the bundled catalogs. All credentials are fakes.
// =============================================================================

const { mcp, integrations } = loadIntegrationCatalogs()
const entry = (id: string): IntegrationEntry => findIntegration(integrations, id)!
const FAKE_PAT = `ghp_${'F'.repeat(36)}`

function config(servers: Record<string, Partial<ServerConfig>>): HubConfig {
  return { servers: servers as Record<string, ServerConfig> } as HubConfig
}

describe('picker', () => {
  it('offers every catalog integration with how it signs in', () => {
    const options = integrationPickerOptions(integrations, [])
    expect(options.map((o) => o.value)).toEqual(integrations.integrations.map((e) => e.id))
    expect(options.find((o) => o.value === 'github')?.label).toBe('GitHub — token')
    expect(options.find((o) => o.value === 'gitlab')?.label).toBe('GitLab — browser sign-in, after setup')
    expect(options.find((o) => o.value === 'trello')?.label).toBe('Trello — keys')
  })

  it('leaves out integrations already in mcp.yaml (as an integration or a same-named server)', () => {
    const cfg = config({
      'github-work': { integration: { id: 'github' } as ServerConfig['integration'] },
      linear: {},
      filesystem: {},
    })
    const configured = configuredIntegrationIds(cfg, integrations)
    expect(configured.sort()).toEqual(['github', 'linear'])
    const offered = integrationPickerOptions(integrations, configured).map((o) => o.value)
    expect(offered).not.toContain('github')
    expect(offered).not.toContain('linear')
    expect(offered).toContain('gitlab')
  })

  it('empty + Enter skips; picks accumulate for the Done screen', () => {
    expect(applyIntegrationsPickerSubmit([], ['github'])).toEqual({ kind: 'skip' })
    expect(applyIntegrationsPickerSubmit(['linear', 'github'], ['github'])).toEqual({
      kind: 'configure',
      queue: ['linear', 'github'],
      selected: ['github', 'linear'],
    })
  })
})

describe('per-integration stages', () => {
  it('token variants: level then credentials; OAuth: level only; params first when the server takes any', () => {
    expect(integrationStages(recommendedVariant(entry('github')), mcp)).toEqual(['level', 'credentials'])
    expect(integrationStages(recommendedVariant(entry('linear')), mcp)).toEqual(['level'])
    expect(integrationStages(recommendedVariant(entry('gitlab')), mcp)).toEqual(['params', 'level'])
  })

  it('starts read-only (§13.5) and walks the stages in order', () => {
    const variant = recommendedVariant(entry('github'))
    const draft = freshDraft(variant, mcp)
    expect(draft.accessLevel).toBe('read-only')
    expect(draft.stage).toBe('level')
    expect(nextStage(variant, mcp, 'level')).toBe('credentials')
    expect(nextStage(variant, mcp, 'credentials')).toBeNull()
  })

  it('checks a parameter against its pattern', () => {
    const spec = { label: 'GitLab host', pattern: '^[a-z0-9.-]+(:\\d{1,5})?$', example: 'gitlab.example.com' }
    expect(paramProblem(spec, 'gitlab.com')).toBeNull()
    expect(paramProblem(spec, 'GitLab.Example.com')).toBeNull()
    expect(paramProblem(spec, 'gitlab.com/evil')).toMatch(/GitLab host doesn't look right/)
    expect(paramProblem(spec, '')).not.toBeNull()
  })
})

describe('credentials', () => {
  const github = recommendedVariant(entry('github'))
  const trello = recommendedVariant(entry('trello'))

  it('lists the variant fields with their hint and where to get them', () => {
    const [field] = credentialFields(github, mcp)
    expect(field).toMatchObject({ kind: 'secret', secret: 'github-pat', label: 'GitHub personal access token' })
    expect(field!.whereToGet).toMatch(/^https:\/\/github\.com\//)
    expect(credentialFields(trello, mcp).map((f) => f.secret)).toEqual(['trello-api-key', 'trello-token'])
    expect(credentialFields(recommendedVariant(entry('linear')), mcp)).toEqual([])
  })

  it('refuses a malformed token without echoing it', () => {
    const [field] = credentialFields(github, mcp)
    const problem = credentialProblem(field!, 'notatoken')
    expect(problem).toMatch(/doesn't look like a GitHub personal access token/)
    expect(problem).not.toContain('notatoken')
    expect(credentialProblem(field!, FAKE_PAT)).toBeNull()
  })

  it('empty Enter skips the integration, or keeps a stored value', () => {
    const fields = credentialFields(github, mcp)
    const draft = { ...freshDraft(github, mcp), stage: 'credentials' as const }
    expect(applyCredentialSubmit(draft, fields, '  ', false)).toEqual({ kind: 'skip' })
    const kept = applyCredentialSubmit(draft, fields, '', true)
    expect(kept).toMatchObject({ kind: 'keep', done: true })
    if (kept.kind === 'keep') expect(kept.draft.keep).toEqual(['github-pat'])
  })

  it('collects multi-field credentials one prompt at a time', () => {
    const fields = credentialFields(trello, mcp)
    const draft = { ...freshDraft(trello, mcp), stage: 'credentials' as const }
    expect(applyCredentialSubmit(draft, fields, 'not-hex', false)).toMatchObject({ kind: 'invalid' })
    const first = applyCredentialSubmit(draft, fields, 'f'.repeat(32), false)
    expect(first).toMatchObject({ kind: 'next', done: false })
    if (first.kind !== 'next') throw new Error('expected next')
    expect(first.draft.credIdx).toBe(1)
    const second = applyCredentialSubmit(first.draft, fields, 'fake-trello-token', false)
    expect(second).toMatchObject({ kind: 'next', done: true })
    if (second.kind === 'next') {
      expect(Object.keys(second.draft.credentials)).toEqual(['trello-api-key', 'trello-token'])
    }
  })
})

describe('access and the add input', () => {
  it('defaults to the agents picked in the wizard, else every verified agent', () => {
    expect(wizardAccess(['codex', 'claude-code'])).toEqual({ agents: ['codex', 'claude-code'] })
    expect(wizardAccess([])).toBe('all')
    expect(describeWizardAccess('all')).toBe('every verified agent')
    expect(describeWizardAccess({ agents: ['codex'] })).toBe('codex')
  })

  it('passes a new credential to add, and a replacement of a stored one to rotate', () => {
    const github = recommendedVariant(entry('github'))
    const draft = { ...freshDraft(github, mcp), credentials: { 'github-pat': FAKE_PAT } }
    const fresh = buildWizardAddInput(entry('github'), github, draft, 'all', () => false)
    expect(fresh.input).toEqual({
      id: 'github',
      variant: 'official',
      accessLevel: 'read-only',
      access: 'all',
      credentials: { 'github-pat': FAKE_PAT },
    })
    expect(fresh.rotate).toEqual({})
    const replace = buildWizardAddInput(entry('github'), github, draft, 'all', () => true)
    expect(replace.input.credentials).toBeUndefined()
    expect(replace.rotate).toEqual({ 'github-pat': FAKE_PAT })
  })

  it('carries params and reuses a kept secret by leaving it out', () => {
    const gitlab = recommendedVariant(entry('gitlab'))
    const draft = { ...freshDraft(gitlab, mcp), params: { host: 'gitlab.example.com' }, accessLevel: 'read-write' as const }
    const { input } = buildWizardAddInput(entry('gitlab'), gitlab, draft, { agents: ['codex'] }, () => false)
    expect(input).toEqual({
      id: 'gitlab',
      variant: 'official',
      accessLevel: 'read-write',
      access: { agents: ['codex'] },
      params: { host: 'gitlab.example.com' },
    })
  })
})

describe('Done screen', () => {
  it('names review for token integrations and login for OAuth ones', () => {
    expect(nextCommand('github', false)).toBe('foreman integrations review github')
    expect(nextCommand('gitlab', true)).toBe('foreman integrations login gitlab')
  })

  it('lists only the picked integrations that are still off', () => {
    const cfg = config({
      github: { enabled: false, integration: { id: 'github' } as ServerConfig['integration'] },
      gitlab: { enabled: false, auth: 'oauth', integration: { id: 'gitlab' } as ServerConfig['integration'] },
      linear: { enabled: true, auth: 'oauth', integration: { id: 'linear' } as ServerConfig['integration'] },
      notion: { enabled: false, auth: 'oauth', integration: { id: 'notion' } as ServerConfig['integration'] },
      filesystem: { enabled: false },
    })
    expect(pendingIntegrations(cfg, integrations, ['github', 'gitlab', 'linear'])).toEqual([
      { name: 'github', label: 'GitHub', oauth: false, command: 'foreman integrations review github' },
      { name: 'gitlab', label: 'GitLab', oauth: true, command: 'foreman integrations login gitlab' },
    ])
  })
})

describe('Services picker (§13.2)', () => {
  it('no longer offers GitHub, Atlassian and Notion; they stay in services.json', () => {
    expect(INTEGRATION_MANAGED_SERVICES).toEqual(['github', 'atlassian', 'notion'])
    const catalog = [{ id: 'telegram' }, { id: 'github' }, { id: 'atlassian' }, { id: 'notion' }, { id: 'slack' }]
    expect(wizardServiceChoices(catalog).map((s) => s.id)).toEqual(['telegram', 'slack'])
  })
})
