import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CatalogParamError,
  findCatalogEntry,
  loadBundledMcpCatalog,
  McpCatalogEntrySchema,
  resolveCatalogParams,
  serverConfigFromCatalog,
} from '../../../src/core/mcp-hub/catalog.js'
import {
  loadHubConfig,
  parseHubConfigText,
  toolRuleEffect,
  toolRuleLevel,
  updateHubConfig,
} from '../../../src/core/mcp-hub/config.js'
import { addServer, HubConfigEditError } from '../../../src/core/mcp-hub/manage.js'

// =============================================================================
// ${param:…} substitution — a user-supplied host must never re-point a
// server's URL (userinfo, path, fragment, scheme) or reach the command.
// =============================================================================

describe('catalog params', () => {
  const catalog = loadBundledMcpCatalog()
  const gitlab = findCatalogEntry(catalog, 'gitlab')!

  it('fills the host and applies the default', () => {
    expect(serverConfigFromCatalog(gitlab, [], {}).url).toBe('https://gitlab.com/api/v4/mcp')
    expect(serverConfigFromCatalog(gitlab, [], { host: 'GitLab.Example.com:443' }).url).toBe(
      'https://gitlab.example.com/api/v4/mcp',
    )
    expect(serverConfigFromCatalog(gitlab, [], { host: 'git.corp.local:8443' }).url).toBe(
      'https://git.corp.local:8443/api/v4/mcp',
    )
  })

  it.each([
    'gitlab.com@evil.com',
    'evil.com/#',
    'a.com/#',
    'http://evil.com',
    'https://evil.com',
    'evil.com/x?',
    'evil.com\\@gitlab.com',
    'gitlab.com evil.com',
    'gitlab.com\nX-Evil: 1',
    '${secret:github-pat}',
    'evil.com:99999',
    '',
  ])('refuses host %j', (host) => {
    expect(() => serverConfigFromCatalog(gitlab, [], { host })).toThrow(CatalogParamError)
  })

  it('refuses parameters the entry does not declare', () => {
    expect(() => resolveCatalogParams(gitlab, { url: 'x' })).toThrow(/no parameter 'url'/)
    const github = findCatalogEntry(catalog, 'github')!
    expect(() => addServer(parseHubConfigText(''), catalog, { id: 'github', params: { host: 'x.com' } })).toThrow(
      HubConfigEditError,
    )
    expect(resolveCatalogParams(github, {})).toEqual({})
  })

  it('refuses catalog entries that put a param anywhere but the whole host', () => {
    const base = {
      id: 'x',
      name: 'X',
      description: 'x',
      category: 'developer',
      official: false,
      publisher: 'x',
      homepage: 'https://example.com',
      transport: 'http',
      user_params: [{ name: 'host', label: 'Host', example: 'a.com', pattern: '^[a-z.]+$' }],
    }
    for (const url of ['https://a.com/${param:host}', 'https://${param:host}.evil.com/', 'http://${param:host}/']) {
      expect(McpCatalogEntrySchema.safeParse({ ...base, url }).success, url).toBe(false)
    }
    expect(McpCatalogEntrySchema.safeParse({ ...base, url: 'https://${param:host}/mcp' }).success).toBe(true)
    expect(
      McpCatalogEntrySchema.safeParse({
        ...base,
        transport: 'stdio',
        url: undefined,
        command: 'npx ${param:host}',
      }).success,
    ).toBe(false)
  })
})

describe('confirm rules', () => {
  it('rank deny > confirm > ask > allow, and count as ask until the hub enforces them', () => {
    const rules = { allow: ['merge_*', 'get_*'], ask: ['merge_*'], confirm: ['merge_*'], deny: ['delete_*'] }
    expect(toolRuleLevel(rules, 'merge_pull_request')).toBe('confirm')
    expect(toolRuleEffect(rules, 'merge_pull_request')).toBe('ask')
    expect(toolRuleLevel({ ...rules, deny: ['merge_*'] }, 'merge_pull_request')).toBe('deny')
    expect(toolRuleEffect(rules, 'get_me')).toBe('allow')
  })
})

// =============================================================================
// updateHubConfig — locked, atomic, comment-preserving
// =============================================================================

describe('updateHubConfig', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-hubcfg-'))
    path = join(dir, 'mcp.yaml')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const addCustom = (name: string) => async () =>
    updateHubConfig({ mcpConfigPath: path }, (c) => ({
      ...c,
      servers: { ...c.servers, [name]: { ...parseHubConfigText(`servers:\n  x:\n    command: node\n`).servers.x! } },
    }))

  it('creates the file 0600 and leaves no temp files behind', async () => {
    const res = await addCustom('a')()
    expect(res.changed).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([])
    expect(loadHubConfig(path).servers.a!.command).toBe('node')
  })

  it('does not rewrite the file when nothing changed', async () => {
    await addCustom('a')()
    const before = readFileSync(path, 'utf-8')
    writeFileSync(path, `# hand note\n${before}`)
    const res = await updateHubConfig({ mcpConfigPath: path }, (c) => c)
    expect(res.changed).toBe(false)
    expect(readFileSync(path, 'utf-8')).toContain('# hand note')
  })

  it('never loses a concurrent writer', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => addCustom(`s${i}`)()))
    expect(Object.keys(loadHubConfig(path).servers).sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `s${i}`).sort(),
    )
  })

  it('keeps comments on servers it does not touch', async () => {
    writeFileSync(
      path,
      [
        '# my hub',
        'servers:',
        '  keep:',
        '    # the one I wrote by hand',
        '    command: node',
        '    args: [a.js]',
        '',
      ].join('\n'),
    )
    await addCustom('new')()
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('# my hub')
    expect(text).toContain('# the one I wrote by hand')
    expect(Object.keys(loadHubConfig(path).servers).sort()).toEqual(['keep', 'new'])
  })

  it('leaves the file untouched when the edit throws or the result is invalid', async () => {
    await addCustom('a')()
    const before = readFileSync(path, 'utf-8')
    await expect(
      updateHubConfig({ mcpConfigPath: path }, () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(
      updateHubConfig({ mcpConfigPath: path }, (c) => ({
        ...c,
        servers: { ...c.servers, bad: { command: 'x', url: 'https://x' } as never },
      })),
    ).rejects.toThrow()
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })

  it('refuses to overwrite an mcp.yaml that does not validate', async () => {
    writeFileSync(path, 'servers:\n  x:\n    command: node\n    url: https://x\n')
    await expect(addCustom('a')()).rejects.toThrow()
    expect(readFileSync(path, 'utf-8')).toContain('url: https://x')
  })
})
