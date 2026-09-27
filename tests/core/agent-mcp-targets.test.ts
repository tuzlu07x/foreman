import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pickMcpConfigPath } from '../../src/core/agent-add-flow.js'
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
})
