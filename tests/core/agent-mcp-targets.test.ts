import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { pickMcpConfigPath } from '../../src/core/agent-add-flow.js'
import { buildMcpRegisterHint } from '../../src/core/agent-mcp-register-hint.js'
import { readWiredAgentToken } from '../../src/core/agent-config-injector.js'
import { verifyAgentToken } from '../../src/core/agent-token.js'
import { auditAgentTokens, rewireAgent } from '../../src/core/agent-wiring.js'
import { isForemanServedTool } from '../../src/core/foreman-mcp-trust.js'
import { findAgent, loadBundledRegistry, type AgentEntry } from '../../src/core/registry-catalog.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { generateMasterKey } from '../../src/identity/encryption.js'

// Each agent's MCP wiring (and its #618 token) must land where that agent
// actually reads MCP servers (#591 registry audit).

const mode = (path: string): number => statSync(path).mode & 0o777

/** The bundled registry entry, with its `~/` paths pointed at `home`. */
function bundled(id: string, home: string): AgentEntry {
  const entry = findAgent(loadBundledRegistry(), id)
  const rehome = (p: string): string => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
  return {
    ...entry,
    config_paths: entry.config_paths.map(rehome),
    ...(entry.mcp_config ? { mcp_config: { ...entry.mcp_config, paths: entry.mcp_config.paths.map(rehome) } } : {}),
  }
}

describe('MCP wiring targets', () => {
  let home: string
  let sqlite: Database.Database
  let store: SecretStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-mcp-targets-'))
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, generateMasterKey())
  })
  afterEach(() => {
    sqlite.close()
    rmSync(home, { recursive: true, force: true })
  })

  describe('Claude Code', () => {
    it('declares ~/.claude.json as its MCP config; settings.json stays for env and the hook', () => {
      const entry = findAgent(loadBundledRegistry(), 'claude-code')
      expect(entry.mcp_config).toEqual({ paths: ['~/.claude.json'], layout: 'map', key: 'mcpServers' })
      expect(entry.config_paths[0]).toBe('~/.claude/settings.json')
      expect(entry.secret_projection?.json_env?.path).toBe('~/.claude/settings.json')
    })

    it('writes mcpServers.foreman into ~/.claude.json, keeping every other key, owner-only', () => {
      const entry = bundled('claude-code', home)
      const claudeJson = join(home, '.claude.json')
      const existing = {
        numStartups: 12,
        projects: { '/work/app': { mcpServers: {}, allowedTools: [] } },
        mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } },
      }
      writeFileSync(claudeJson, JSON.stringify(existing, null, 2), { mode: 0o644 })
      mkdirSync(join(home, '.claude'))
      writeFileSync(join(home, '.claude', 'settings.json'), '{"env":{}}')

      expect(pickMcpConfigPath(entry)).toBe(claudeJson)
      const result = rewireAgent(store, 'claude-code', entry)
      expect(result).toMatchObject({ configPath: claudeJson, config: 'written', minted: true })

      const doc = JSON.parse(readFileSync(claudeJson, 'utf-8')) as typeof existing & {
        mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
      }
      expect(doc.numStartups).toBe(12)
      expect(doc.projects).toEqual(existing.projects)
      expect(doc.mcpServers.github).toEqual(existing.mcpServers.github)
      expect(doc.mcpServers.foreman).toMatchObject({ command: 'foreman', args: ['mcp-stdio', '--source', 'claude-code'] })
      expect(verifyAgentToken(store, 'claude-code', doc.mcpServers.foreman!.env!.FOREMAN_AGENT_TOKEN!)).toBe(true)
      expect(mode(claudeJson)).toBe(0o600)
      // settings.json is not an MCP config: untouched.
      expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toBe('{"env":{}}')

      // The hook's trust check reads the same entry and accepts it.
      const hubConfigPath = join(home, 'mcp.yaml')
      expect(isForemanServedTool('mcp__foreman__submit_approval', { cwd: home, hubConfigPath, home, env: {} })).toBe(true)
      // And doctor's audit looks there too.
      expect(auditAgentTokens([{ id: 'claude-code', metadata: { registryId: 'claude-code' } }], store, () => entry)).toEqual({
        missing: [],
        stale: [],
      })
    })

    it('creates ~/.claude.json when Claude Code has not written one yet', () => {
      const entry = bundled('claude-code', home)
      rewireAgent(store, 'claude-code', entry)
      expect(readWiredAgentToken(join(home, '.claude.json'))).toMatch(/^fat_/)
    })

    it('writes through a symlinked dotfile instead of replacing the link', () => {
      const entry = bundled('claude-code', home)
      const real = join(home, 'dotfiles-claude.json')
      writeFileSync(real, '{"theme":"dark"}')
      symlinkSync(real, join(home, '.claude.json'))
      rewireAgent(store, 'claude-code', entry)
      const doc = JSON.parse(readFileSync(real, 'utf-8')) as { theme: string; mcpServers: Record<string, unknown> }
      expect(doc.theme).toBe('dark')
      expect(doc.mcpServers.foreman).toBeDefined()
    })
  })

  describe('Hermes', () => {
    it('declares mcp_servers in config.yaml and no `hermes mcp add` step', () => {
      const entry = findAgent(loadBundledRegistry(), 'hermes')
      expect(entry.mcp_config).toMatchObject({ layout: 'map', key: 'mcp_servers' })
      expect(entry.mcp_config?.paths[0]).toBe('~/.hermes/config.yaml')
      // One mechanism: Foreman writes the config itself, so the wizard
      // never runs (or prompts through) `hermes mcp add`.
      expect(buildMcpRegisterHint('hermes', entry)).toBeNull()
    })

    it('writes mcp_servers.foreman, replaces a `hermes mcp add` wrapper entry and drops the old mcpServers one', () => {
      const entry = bundled('hermes', home)
      const config = join(home, '.hermes', 'config.yaml')
      mkdirSync(join(home, '.hermes'))
      writeFileSync(
        config,
        [
          'model:',
          '  default: anthropic/claude-haiku-4-5',
          'mcp_servers:',
          '  github:',
          '    command: npx',
          '    args: [-y, gh-mcp]',
          '  foreman:',
          '    command: /home/me/.foreman/wrappers/hermes-mcp.sh',
          'mcpServers:',
          '  foreman:',
          '    command: foreman',
          '    args: [mcp-stdio, --source, hermes]',
          '',
        ].join('\n'),
      )
      const result = rewireAgent(store, 'hermes', entry)
      expect(result).toMatchObject({ configPath: config, config: 'replaced', wrapperPath: null })
      const doc = parseYaml(readFileSync(config, 'utf-8')) as {
        model: { default: string }
        mcp_servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
        mcpServers?: unknown
      }
      expect(doc.model.default).toBe('anthropic/claude-haiku-4-5')
      expect(doc.mcp_servers.github).toEqual({ command: 'npx', args: ['-y', 'gh-mcp'] })
      expect(doc.mcp_servers.foreman).toMatchObject({ command: 'foreman', args: ['mcp-stdio', '--source', 'hermes'] })
      expect(verifyAgentToken(store, 'hermes', doc.mcp_servers.foreman!.env!.FOREMAN_AGENT_TOKEN!)).toBe(true)
      expect(doc.mcpServers).toBeUndefined()
      expect(mode(config)).toBe(0o600)
      // Running it again changes nothing.
      expect(rewireAgent(store, 'hermes', entry).config).toBe('current')
    })
  })

  describe('ZeroClaw', () => {
    interface ZcDoc {
      default_provider?: string
      mcpServers?: unknown
      mcp: { servers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }> }
      mcp_bundles: Record<string, { servers: string[]; exclude?: string[] }>
      agents?: Record<string, { mcp_bundles?: string[]; model?: string }>
    }
    const read = (path: string): ZcDoc => parseToml(readFileSync(path, 'utf-8')) as unknown as ZcDoc

    it('declares the zeroclaw layout for config.toml', () => {
      expect(findAgent(loadBundledRegistry(), 'zeroclaw').mcp_config).toEqual({
        paths: ['~/.zeroclaw/config.toml'],
        layout: 'zeroclaw',
      })
    })

    it('upserts a [[mcp.servers]] foreman entry, defines the bundle and grants it to every agent alias', () => {
      const entry = bundled('zeroclaw', home)
      const config = join(home, '.zeroclaw', 'config.toml')
      mkdirSync(join(home, '.zeroclaw'))
      writeFileSync(
        config,
        [
          'default_provider = "anthropic"',
          '',
          '[[mcp.servers]]',
          'name = "filesystem"',
          'command = "npx"',
          '',
          '[mcp_bundles.files]',
          'servers = ["filesystem"]',
          '',
          '[agents.assistant]',
          'model = "claude-haiku"',
          'mcp_bundles = ["files"]',
          '',
          '[agents.researcher]',
          'model = "claude-sonnet"',
          '',
          // What an older Foreman wrote: ZeroClaw reads `mcpServers` as an
          // alias of `mcp`, so this table only gets in the way.
          '[mcpServers.foreman]',
          'command = "foreman"',
          'args = ["mcp-stdio", "--source", "zeroclaw"]',
          '',
        ].join('\n'),
      )
      const result = rewireAgent(store, 'zeroclaw', entry)
      expect(result).toMatchObject({ configPath: config, config: 'replaced' })
      expect(result.note).toBeUndefined()

      const doc = read(config)
      expect(doc.default_provider).toBe('anthropic')
      expect(doc.mcpServers).toBeUndefined()
      expect(doc.mcp.servers.map((s) => s.name)).toEqual(['filesystem', 'foreman'])
      const foreman = doc.mcp.servers[1]!
      expect(foreman).toMatchObject({ command: 'foreman', args: ['mcp-stdio', '--source', 'zeroclaw'] })
      expect(verifyAgentToken(store, 'zeroclaw', foreman.env!.FOREMAN_AGENT_TOKEN!)).toBe(true)
      expect(doc.mcp_bundles).toEqual({ files: { servers: ['filesystem'] }, foreman: { servers: ['foreman'] } })
      expect(doc.agents?.assistant).toEqual({ model: 'claude-haiku', mcp_bundles: ['files', 'foreman'] })
      expect(doc.agents?.researcher).toEqual({ model: 'claude-sonnet', mcp_bundles: ['foreman'] })
      expect(mode(config)).toBe(0o600)

      // Idempotent, and doctor reads the token from the array entry.
      expect(rewireAgent(store, 'zeroclaw', entry).config).toBe('current')
      expect(read(config).mcp.servers).toHaveLength(2)
      expect(auditAgentTokens([{ id: 'zeroclaw', metadata: { registryId: 'zeroclaw' } }], store, () => entry)).toEqual({
        missing: [],
        stale: [],
      })

      // A rotation replaces the entry in place.
      rewireAgent(store, 'zeroclaw', entry, { rotate: true })
      const rotated = read(config)
      expect(rotated.mcp.servers.map((s) => s.name)).toEqual(['filesystem', 'foreman'])
      expect(verifyAgentToken(store, 'zeroclaw', rotated.mcp.servers[1]!.env!.FOREMAN_AGENT_TOKEN!)).toBe(true)
    })

    it('says so when no agent alias exists to grant the bundle to', () => {
      const entry = bundled('zeroclaw', home)
      const result = rewireAgent(store, 'zeroclaw', entry)
      expect(result.config).toBe('written')
      expect(result.note).toContain('mcp_bundles = ["foreman"]')
      expect(read(join(home, '.zeroclaw', 'config.toml')).mcp_bundles.foreman).toEqual({ servers: ['foreman'] })
    })
  })
})
