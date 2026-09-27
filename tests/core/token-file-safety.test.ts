import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyInjection, planInjection } from '../../src/core/agent-config-injector.js'
import { buildMcpSnippet } from '../../src/core/agent-mcp-snippet.js'
import { rewireAgent } from '../../src/core/agent-wiring.js'
import type { AgentEntry } from '../../src/core/registry-catalog.js'
import { foremanSelfProtectionRule } from '../../src/core/risk-rules/foreman-self-protection.js'
import type { RiskContext } from '../../src/core/risk-rules/types.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { checkTokenPath, UnsafeTokenPathError } from '../../src/core/token-file-safety.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { generateMasterKey } from '../../src/identity/encryption.js'

// #618 review — files that hold an agent token: no symlinks, nothing inside
// a project's git work tree, owner-only even when already current; and an
// agent touching another agent's wiring (or any /proc/*/environ) is flagged.

const entry = { id: 'claude-code', mcp_compatible: true, install: { npm: null, brew: null }, config_paths: [] } as unknown as AgentEntry
const mode = (path: string): number => statSync(path).mode & 0o777

describe('token file safety', () => {
  let dir: string
  let sqlite: Database.Database
  let store: SecretStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-token-files-'))
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, generateMasterKey())
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a config inside a project git work tree (e.g. a committed .mcp.json)', () => {
    const repo = join(dir, 'projects', 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    expect(() => checkTokenPath(join(repo, '.mcp.json'), join(dir, 'home'))).toThrow(UnsafeTokenPathError)
    expect(() => rewireAgent(store, 'claude-code', entry, { configPath: join(repo, '.mcp.json') })).toThrow(/git work tree/)
    expect(() => rewireAgent(store, 'bot', null, { tokenOut: join(repo, 'bot.token') })).toThrow(/git work tree/)
  })

  it('allows a dotfiles repo at the home directory, with a warning', () => {
    mkdirSync(join(dir, '.git'))
    expect(checkTokenPath(join(dir, '.claude.json'), dir)).toMatch(/make sure git ignores it/)
    expect(checkTokenPath(join(tmpdir(), 'not-in-a-repo', 'x.json'), dir)).toBeNull()
  })

  it('refuses symlinks for the token-out file', () => {
    const real = join(dir, 'real.token')
    writeFileSync(real, '')
    symlinkSync(real, join(dir, 'link.token'))
    expect(() => rewireAgent(store, 'bot', null, { tokenOut: join(dir, 'link.token') })).toThrow(UnsafeTokenPathError)
    expect(readFileSync(real, 'utf-8')).toBe('')
  })

  it('tightens the mode to 0600 even when the entry is already current', () => {
    const path = join(dir, 'settings.json')
    const snippet = buildMcpSnippet('claude-code', entry, 'fat_x').json
    applyInjection(path, planInjection(path, snippet))
    chmodSync(path, 0o644)
    const plan = planInjection(path, snippet)
    expect(plan.alreadyHasForeman).toBe(true)
    applyInjection(path, plan)
    expect(mode(path)).toBe(0o600)
  })
})

describe('self-protection: token-bearing wiring and process environments', () => {
  const ctx = { db: null as never } as RiskContext
  const rules = (sourceAgent: string, args: unknown): string[] =>
    foremanSelfProtectionRule.evaluate({ sourceAgent, targetTool: 'bash', args }, ctx).map((f) => f.rule)

  it("flags an agent reading ANOTHER agent's MCP config, not its own", () => {
    expect(rules('claude-code', { command: 'cat ~/.codex/config.toml' })).toContain('agent_token_access')
    expect(rules('untrusted:codex', { command: 'cat ~/.claude.json' })).toContain('agent_token_access')
    expect(rules('codex', { command: 'cat ~/.codex/config.toml' })).not.toContain('agent_token_access')
    expect(rules('hermes', { path: '/home/u/.zeroclaw/config.toml' })).toContain('agent_token_access')
  })

  it('flags reads of any process environment', () => {
    expect(rules('codex', { command: 'cat /proc/4242/environ' })).toContain('process_environ_access')
    expect(rules('codex', { command: 'tr "\\0" "\\n" < /proc/self/environ' })).toContain('process_environ_access')
    expect(rules('codex', { command: 'cat /proc/cpuinfo' })).not.toContain('process_environ_access')
  })

  it('scores them as critical', () => {
    const factors = foremanSelfProtectionRule.evaluate(
      { sourceAgent: 'claude-code', targetTool: 'read_file', args: { path: '/home/u/.hermes/config.yaml' } },
      ctx,
    )
    expect(factors.find((f) => f.rule === 'agent_token_access')?.points).toBeGreaterThanOrEqual(85)
  })
})
