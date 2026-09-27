import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWiredAgentToken } from '../../src/core/agent-config-injector.js'
import { AGENT_TOKEN_PLACEHOLDER, buildMcpSnippet } from '../../src/core/agent-mcp-snippet.js'
import { hasAgentToken, issueAgentToken, verifyAgentToken } from '../../src/core/agent-token.js'
import { auditAgentTokens, describeTokenAudit, rewireAgent, writeAgentWiring } from '../../src/core/agent-wiring.js'
import type { AgentEntry } from '../../src/core/registry-catalog.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { generateMasterKey } from '../../src/identity/encryption.js'

// #618 — the agent's MCP wiring carries its identity token in the server's
// env (never argv), in files only the owner can read.

function entry(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    tagline: 'tag',
    homepage: 'https://example.com',
    install: { npm: null, brew: null },
    config_paths: [],
    config_snippet: null,
    required_secrets: [],
    optional_secrets: [],
    llm_compat: [],
    mcp_compatible: true,
    supported_versions: '*',
    min_foreman_version: '0.1.0',
    ...overrides,
  }
}

const mode = (path: string): number => statSync(path).mode & 0o777

describe('agent MCP wiring with identity tokens', () => {
  let dir: string
  let sqlite: Database.Database
  let store: SecretStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-wiring-'))
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, generateMasterKey())
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the snippet passes the token as an env var, not an argument; shown snippets carry a placeholder', () => {
    const withToken = buildMcpSnippet('codex', entry({}), 'fat_abc').json as {
      mcpServers: { foreman: { args: string[]; env: Record<string, string> } }
    }
    expect(withToken.mcpServers.foreman.env).toEqual({ FOREMAN_AGENT_TOKEN: 'fat_abc' })
    expect(withToken.mcpServers.foreman.args.join(' ')).not.toContain('fat_abc')
    const shown = buildMcpSnippet('codex', entry({}))
    expect(shown.yaml).toContain(AGENT_TOKEN_PLACEHOLDER)
  })

  it('JSON (Claude Code): keeps other settings, adds the env block, makes the file owner-only', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ theme: 'dark', mcpServers: { foreman: { command: 'foreman', args: ['mcp-stdio', '--source', 'claude-code'] } } }), { mode: 0o644 })
    const token = issueAgentToken(store, 'claude-code')
    const result = writeAgentWiring('claude-code', entry({}), token, { configPath: path })
    expect(result.config).toBe('replaced')
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as { theme: string; mcpServers: { foreman: { env: Record<string, string> } } }
    expect(doc.theme).toBe('dark')
    expect(doc.mcpServers.foreman.env.FOREMAN_AGENT_TOKEN).toBe(token)
    expect(mode(path)).toBe(0o600)
    expect(readWiredAgentToken(path)).toBe(token)
  })

  it('TOML (Codex): writes an env table under mcp_servers.foreman', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(path, 'model = "gpt-5"\n')
    writeAgentWiring('codex', entry({ id: 'codex', mcp_servers_key: 'mcp_servers' }), 'fat_codex', { configPath: path })
    const doc = parseToml(readFileSync(path, 'utf-8')) as { model: string; mcp_servers: { foreman: { env: Record<string, string> } } }
    expect(doc.model).toBe('gpt-5')
    expect(doc.mcp_servers.foreman.env.FOREMAN_AGENT_TOKEN).toBe('fat_codex')
  })

  it('YAML + wrapper (Hermes): the wrapper exports the token and is 0700', () => {
    const path = join(dir, 'config.yaml')
    const hermes = entry({
      id: 'hermes',
      mcp_register_cli: {
        command_template: 'hermes mcp add foreman --command {wrapper_path}',
        wrapper: {
          path_template: '~/.foreman/wrappers/{agent_id}-mcp.sh',
          content_template: '#!/usr/bin/env bash\nexec foreman mcp-stdio --source {agent_id}\n',
        },
      },
    })
    const result = writeAgentWiring('hermes', hermes, 'fat_hermes', { configPath: path, homeDir: dir })
    expect((parseYaml(readFileSync(path, 'utf-8')) as { mcpServers: { foreman: { env: Record<string, string> } } }).mcpServers.foreman.env.FOREMAN_AGENT_TOKEN).toBe('fat_hermes')
    expect(result.wrapperPath).toBe(join(dir, '.foreman/wrappers/hermes-mcp.sh'))
    const script = readFileSync(result.wrapperPath!, 'utf-8')
    expect(script).toBe("#!/usr/bin/env bash\nexport FOREMAN_AGENT_TOKEN='fat_hermes'\nexec foreman mcp-stdio --source hermes\n")
    expect(mode(result.wrapperPath!)).toBe(0o700)
  })

  it('rewire keeps the current token; rotate replaces it and rewrites the wiring', () => {
    const path = join(dir, 'settings.json')
    const first = rewireAgent(store, 'claude-code', entry({}), { configPath: path })
    expect(first).toMatchObject({ minted: true, config: 'written' })
    const token = readWiredAgentToken(path)!
    expect(verifyAgentToken(store, 'claude-code', token)).toBe(true)

    expect(rewireAgent(store, 'claude-code', entry({}), { configPath: path })).toMatchObject({ minted: false, config: 'current' })
    expect(readWiredAgentToken(path)).toBe(token)

    expect(rewireAgent(store, 'claude-code', entry({}), { configPath: path, rotate: true })).toMatchObject({ minted: true, config: 'replaced' })
    const rotated = readWiredAgentToken(path)!
    expect(rotated).not.toBe(token)
    expect(verifyAgentToken(store, 'claude-code', token)).toBe(false)
    expect(verifyAgentToken(store, 'claude-code', rotated)).toBe(true)
  })

  it('writes the token to --token-out (0600) for agents wired by hand, and mints nothing it cannot deliver', () => {
    expect(rewireAgent(store, 'bot', null)).toMatchObject({ minted: false, config: 'none' })
    expect(hasAgentToken(store, 'bot')).toBe(false)
    const out = join(dir, 'bot.token')
    writeFileSync(out, 'old', { mode: 0o644 })
    const res = rewireAgent(store, 'bot', null, { tokenOut: out })
    expect(res).toMatchObject({ minted: true, tokenOutPath: out })
    expect(verifyAgentToken(store, 'bot', readFileSync(out, 'utf-8').trim())).toBe(true)
    expect(mode(out)).toBe(0o600)
  })

  it('audit finds agents with no token and wiring that lost or kept an old token', () => {
    const fresh = join(dir, 'fresh.json')
    const stale = join(dir, 'stale.json')
    const elsewhere = join(dir, 'elsewhere.json')
    const e = (path: string): AgentEntry => entry({ config_paths: [path] })
    const entries: Record<string, AgentEntry> = { fresh: e(fresh), stale: e(stale), elsewhere: e(elsewhere) }
    rewireAgent(store, 'fresh', entries.fresh!)
    rewireAgent(store, 'stale', entries.stale!)
    issueAgentToken(store, 'stale') // rotated without rewriting the file
    issueAgentToken(store, 'elsewhere') // default file has no foreman entry: wired elsewhere
    writeFileSync(elsewhere, '{}')
    const agents = ['fresh', 'stale', 'elsewhere', 'legacy'].map((id) => ({ id, metadata: { registryId: id } }))
    const audit = auditAgentTokens(agents, store, (id) => entries[id] ?? null)
    expect(audit).toEqual({ missing: ['legacy'], stale: ['stale'] })
    const text = describeTokenAudit(audit)!
    expect(text.message).toContain('legacy')
    expect(text.remediation).toContain('foreman agent rewire --all')
    expect(JSON.stringify(text)).not.toMatch(/fat_/)
    expect(describeTokenAudit({ missing: [], stale: [] })).toBeNull()
  })
})
