import type Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBundledIntegrationCatalog } from '../../../src/core/integrations/catalog.js'
import {
  IntegrationError,
  IntegrationNotReadyError,
  IntegrationService,
  type IntegrationActor,
} from '../../../src/core/integrations/service.js'
import { loadBundledMcpCatalog } from '../../../src/core/mcp-hub/catalog.js'
import { loadHubConfig, toolRuleLevel } from '../../../src/core/mcp-hub/config.js'
import { ToolPinStore } from '../../../src/core/mcp-hub/pins.js'
import { launchFingerprint } from '../../../src/core/integrations/status.js'
import { SecretStore } from '../../../src/core/secret-store.js'
import { createInMemoryDb } from '../../../src/db/client.js'
import { generateMasterKey } from '../../../src/identity/encryption.js'

const mcpCatalog = loadBundledMcpCatalog()
const integrationCatalog = loadBundledIntegrationCatalog()
const CLI: IntegrationActor = { via: 'cli' }
const PAT = 'ghp_' + 'A'.repeat(36)
const PAT2 = 'ghp_' + 'B'.repeat(36)

describe('IntegrationService', () => {
  let dir: string
  let sqlite: Database.Database
  let secrets: SecretStore
  let pins: ToolPinStore
  let events: Array<{ type: string; payload: Record<string, unknown> }>
  let removedSessions: string[]
  let clock: number
  let svc: IntegrationService
  const mcpPath = () => join(dir, 'mcp.yaml')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-integrations-'))
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    secrets = new SecretStore(handle.db, generateMasterKey())
    pins = new ToolPinStore(join(dir, 'mcp-pins.json'))
    events = []
    removedSessions = []
    clock = Date.parse('2026-09-28T10:00:00Z')
    svc = new IntegrationService({
      paths: { mcpConfigPath: mcpPath() },
      mcpCatalog,
      integrationCatalog,
      secrets,
      pins,
      audit: { logEvent: (type, payload) => void events.push({ type, payload: payload as Record<string, unknown> }) },
      removeOAuthSession: async (server) => {
        removedSessions.push(server)
        return true
      },
      now: () => new Date((clock += 1000)),
    })
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Pin the server's current launch config, as a review would. */
  const review = (name: string) => {
    const server = loadHubConfig(mcpPath()).servers[name]!
    pins.pin(name, launchFingerprint(server), [{ name: 'get_me', description: 'who am i', inputSchema: {} }])
  }

  describe('add', () => {
    it('stores the credential, writes a disabled integration block and audits names only', async () => {
      const res = await svc.add(
        { id: 'gh', access: { agents: ['codex', 'claude-code', 'codex'] }, credentials: { 'github-pat': PAT } },
        CLI,
      )
      expect(res.name).toBe('github')
      expect(secrets.get('github-pat')).toBe(PAT)
      const server = loadHubConfig(mcpPath()).servers.github!
      expect(server.enabled).toBe(false)
      expect(server.access).toEqual({ agents: ['claude-code', 'codex'] })
      expect(server.integration).toMatchObject({ id: 'github', variant: 'official', access_level: 'read-only' })
      expect(toolRuleLevel(server.tools, 'issue_write')).toBe('deny')
      const text = readFileSync(mcpPath(), 'utf-8')
      expect(text).not.toContain(PAT)
      expect(text).toContain('${secret:github-pat}')
      expect(events.map((e) => e.type)).toEqual(['integration:added'])
      expect(events[0]!.payload).toMatchObject({ integration: 'github', server: 'github', via: 'cli', secrets: ['github-pat'] })
      expect(JSON.stringify(events)).not.toContain(PAT)
    })

    it('"all" leaves access open to every verified agent', async () => {
      await svc.add({ id: 'linear', variant: 'token', access: 'all', credentials: { 'linear-api-key': 'lin_api_' + 'x'.repeat(40) } }, CLI)
      expect(loadHubConfig(mcpPath()).servers.linear!.access).toBeUndefined()
    })

    it('refuses a credential that does not match the catalog pattern, without echoing it', async () => {
      const err = await svc
        .add({ id: 'github', access: 'all', credentials: { 'github-pat': 'not-a-token-SECRETVALUE' } }, CLI)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(IntegrationError)
      expect((err as Error).message).not.toContain('SECRETVALUE')
      expect(secrets.exists('github-pat')).toBe(false)
    })

    it('rolls back the stored secret when the server name is taken', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      await expect(
        svc.add(
          { id: 'github', access: 'all', secretNames: { 'github-pat': 'github-pat-2' }, credentials: { 'github-pat': PAT2 } },
          CLI,
        ),
      ).rejects.toThrow(/already exists/)
      expect(secrets.exists('github-pat-2')).toBe(false)
      expect(secrets.get('github-pat')).toBe(PAT)
      expect(events.map((e) => e.type)).toEqual(['integration:added'])
    })

    it('refuses to overwrite an existing secret, and reuses it when no value is given', async () => {
      secrets.add('github-pat', PAT)
      await expect(svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT2 } }, CLI)).rejects.toThrow(
        /already exists/,
      )
      expect(secrets.get('github-pat')).toBe(PAT)
      await svc.add({ id: 'github', access: 'all' }, CLI)
      expect(loadHubConfig(mcpPath()).servers.github).toBeDefined()
    })

    it('adds a second account under its own server and secret names', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      await svc.add(
        {
          id: 'github',
          name: 'github-work',
          access: 'all',
          secretNames: { 'github-pat': 'github-pat-work' },
          credentials: { 'github-pat': PAT2 },
        },
        CLI,
      )
      const config = loadHubConfig(mcpPath())
      expect(config.servers['github-work']!.headers.Authorization).toBe('Bearer ${secret:github-pat-work}')
      expect(secrets.get('github-pat-work')).toBe(PAT2)
      // The id is now ambiguous: callers must name the server.
      await expect(svc.disable('github', CLI)).resolves.toBeUndefined()
      await expect(svc.disable('gh', CLI)).rejects.toThrow(/github, github-work — which one\?/)
    })

    it('stores basic credentials as base64(user:password)', async () => {
      await svc.add(
        { id: 'atlassian', variant: 'token', access: 'all', basicAuth: { username: 'me@example.com', password: 'tok' } },
        CLI,
      )
      expect(Buffer.from(secrets.get('atlassian-mcp-basic'), 'base64').toString()).toBe('me@example.com:tok')
      await expect(
        svc.add({ id: 'atlassian', variant: 'token', name: 'a2', access: 'all', basicAuth: { username: 'a:b', password: 'x' } }, CLI),
      ).rejects.toThrow(/without ':'/)
    })

    it('refuses notification-channel secret names', async () => {
      await expect(
        svc.add({ id: 'github', access: 'all', secretNames: { 'github-pat': 'slack-bot-token' }, credentials: { 'github-pat': PAT } }, CLI),
      ).rejects.toThrow(/notification channel/)
    })
  })

  describe('enable / disable', () => {
    it('refuses to enable before the tools are reviewed or while a secret is missing', async () => {
      await svc.add({ id: 'github', access: 'all' }, CLI)
      const err = await svc.enable('github', CLI).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(IntegrationNotReadyError)
      expect((err as IntegrationNotReadyError).status.problems.map((p) => p.kind).sort()).toEqual([
        'missing-secret',
        'not-reviewed',
      ])
      expect(loadHubConfig(mcpPath()).servers.github!.enabled).toBe(false)
    })

    it('enables once ready, and audits each real change once', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      review('github')
      const status = await svc.enable('github', { via: 'slack', actor: 'U0123' })
      expect(status.state).toBe('enabled')
      await svc.enable('github', CLI)
      await svc.disable('github', CLI)
      await svc.disable('github', CLI)
      expect(events.map((e) => e.type)).toEqual(['integration:added', 'integration:enabled', 'integration:disabled'])
      expect(events[1]!.payload).toMatchObject({ via: 'slack', actor: 'U0123' })
    })

    it('refuses plain MCP servers and unknown names', async () => {
      writeFileSync(mcpPath(), 'servers:\n  mine:\n    command: node\n')
      await expect(svc.disable('mine', CLI)).rejects.toThrow(/MCP server, not an integration/)
      await expect(svc.disable('nope', CLI)).rejects.toThrow(/no integration 'nope'/)
    })
  })

  describe('update', () => {
    it('changes the access level and audience without touching the launch config', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      review('github')
      await svc.enable('github', CLI)
      const res = await svc.update('github', { accessLevel: 'read-write', access: { agents: ['codex'] } }, CLI)
      expect(res.needsReview).toBe(false)
      const server = loadHubConfig(mcpPath()).servers.github!
      expect(server.enabled).toBe(true)
      expect(server.access).toEqual({ agents: ['codex'] })
      expect(toolRuleLevel(server.tools, 'issue_write')).not.toBe('deny')
      expect(pins.get('github', launchFingerprint(server))).not.toBeNull()
      expect(events.at(-1)).toMatchObject({ type: 'integration:updated', payload: { changes: ['access_level', 'access'] } })
    })

    it('forgets the pins and disables when what the hub launches changes', async () => {
      await svc.add({ id: 'gitlab', variant: 'community', access: 'all', credentials: { 'gitlab-pat': 'glpat-' + 'a'.repeat(20) } }, CLI)
      review('gitlab')
      await svc.enable('gitlab', CLI)
      const res = await svc.update('gitlab', { variant: 'official', params: { host: 'git.example.com' } }, CLI)
      expect(res.needsReview).toBe(true)
      const server = loadHubConfig(mcpPath()).servers.gitlab!
      expect(server.enabled).toBe(false)
      expect(server.url).toBe('https://git.example.com/api/v4/mcp')
      expect(server.auth).toBe('oauth')
      expect(server.integration!.secrets).toEqual({})
      expect(pins.get('gitlab', launchFingerprint(server))).toBeNull()
      expect(events.at(-1)!.payload).toMatchObject({ changes: expect.arrayContaining(['variant', 'params']), disabled_for_review: true })
    })

    it('sets and clears a per-tool override', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      await svc.update('github', { toolOverride: { tool: 'get_me', choice: 'deny' } }, CLI)
      expect(toolRuleLevel(loadHubConfig(mcpPath()).servers.github!.tools, 'get_me')).toBe('deny')
      await svc.update('github', { toolOverride: { tool: 'get_me', choice: 'default' } }, CLI)
      expect(toolRuleLevel(loadHubConfig(mcpPath()).servers.github!.tools, 'get_me')).toBe('allow')
    })

    it('reports overrides a catalog rule shadows', async () => {
      await svc.add({ id: 'github', access: 'all', accessLevel: 'read-write', credentials: { 'github-pat': PAT } }, CLI)
      const res = await svc.update('github', { toolOverride: { tool: 'merge_pull_request', choice: 'allow' } }, CLI)
      expect(res.ignoredOverrides).toEqual([{ tool: 'merge_pull_request', wanted: 'allow', effective: 'confirm' }])
    })

    it('does nothing (and audits nothing) when nothing changes', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      const before = readFileSync(mcpPath(), 'utf-8')
      await svc.update('github', { accessLevel: 'read-only' }, CLI)
      expect(readFileSync(mcpPath(), 'utf-8')).toBe(before)
      expect(events).toHaveLength(1)
    })
  })

  describe('rotateSecret', () => {
    it('replaces the value, bumps updated_at and audits the name only', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      const before = loadHubConfig(mcpPath()).servers.github!.integration!.updated_at
      await svc.rotateSecret('github', 'github-pat', PAT2, CLI)
      expect(secrets.get('github-pat')).toBe(PAT2)
      expect(loadHubConfig(mcpPath()).servers.github!.integration!.updated_at > before).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: 'integration:updated', payload: { changes: ['credential'], secrets: ['github-pat'] } })
      expect(JSON.stringify(events)).not.toContain(PAT2)
      await expect(svc.rotateSecret('github', 'nope', PAT2, CLI)).rejects.toThrow(/no credential 'nope'/)
    })
  })

  describe('adopt', () => {
    it('turns a `foreman mcp add` server into an integration, keeping its secret name', async () => {
      writeFileSync(
        mcpPath(),
        [
          'servers:',
          '  gh-old:',
          '    catalog_id: github',
          '    url: https://api.githubcopilot.com/mcp/',
          '    headers: { Authorization: "Bearer ${secret:my-gh}" }',
          '',
        ].join('\n'),
      )
      const before = loadHubConfig(mcpPath()).servers['gh-old']!
      review('gh-old')
      const res = await svc.adopt('gh-old', { id: 'github', access: { agents: ['codex'] } }, CLI)
      const server = loadHubConfig(mcpPath()).servers['gh-old']!
      expect(server.integration).toMatchObject({ id: 'github', variant: 'official', secrets: { 'github-pat': 'my-gh' } })
      expect(server.headers.Authorization).toBe('Bearer ${secret:my-gh}')
      expect(server.access).toEqual({ agents: ['codex'] })
      // Same launch config: stays enabled, pins kept.
      expect(res.needsReview).toBe(false)
      expect(server.enabled).toBe(before.enabled)
      expect(events.at(-1)).toMatchObject({ type: 'integration:added', payload: { adopted: true } })
      await expect(svc.adopt('gh-old', { id: 'github', access: 'all' }, CLI)).rejects.toThrow(/already an integration/)
    })

    it('needs a variant when the server was not added from the catalog', async () => {
      writeFileSync(mcpPath(), 'servers:\n  mine:\n    command: node\n')
      await expect(svc.adopt('mine', { id: 'github', access: 'all' }, CLI)).rejects.toThrow(/pass --variant/)
    })
  })

  describe('remove', () => {
    it('removes the block, pins and secrets no other server uses', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      review('github')
      const res = await svc.remove('github', CLI)
      expect(res).toMatchObject({ name: 'github', removedSecrets: ['github-pat'], keptSecrets: [] })
      expect(loadHubConfig(mcpPath()).servers.github).toBeUndefined()
      expect(secrets.exists('github-pat')).toBe(false)
      expect(pins.get('github', launchFingerprint({ url: 'https://api.githubcopilot.com/mcp/', args: [] }))).toBeNull()
      expect(events.at(-1)).toMatchObject({ type: 'integration:removed', payload: { removed_secrets: ['github-pat'] } })
    })

    it('keeps a secret another server still references, or all of them with keepSecrets', async () => {
      await svc.add({ id: 'github', access: 'all', credentials: { 'github-pat': PAT } }, CLI)
      await svc.add({ id: 'github', variant: 'docker', name: 'github-local', access: 'all' }, CLI)
      const res = await svc.remove('github', CLI)
      expect(res.keptSecrets).toEqual(['github-pat'])
      expect(secrets.get('github-pat')).toBe(PAT)
      const kept = await svc.remove('github-local', CLI, { keepSecrets: true })
      expect(kept.keptSecrets).toEqual(['github-pat'])
      expect(secrets.exists('github-pat')).toBe(true)
    })

    it('drops the OAuth session of an OAuth integration', async () => {
      await svc.add({ id: 'linear', access: 'all' }, CLI)
      const res = await svc.remove('linear', CLI)
      expect(removedSessions).toEqual(['linear'])
      expect(res.oauthSessionRemoved).toBe(true)
    })
  })
})
