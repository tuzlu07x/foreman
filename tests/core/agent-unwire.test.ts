import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { FOREMAN_HOOK_MARKER, installPreToolUseHook } from '../../src/core/agent-hook.js'
import { rewireAgent, unwireAgent } from '../../src/core/agent-wiring.js'
import { findAgent, loadBundledRegistry, type AgentEntry } from '../../src/core/registry-catalog.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { generateMasterKey } from '../../src/identity/encryption.js'

// QA M8 — `foreman agent remove` revoked the token but left Foreman's
// `foreman` MCP entry (and Claude Code's PreToolUse hook) in the agent's
// config. `unwireAgent` is the inverse of the wiring writers.

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

type Doc = Record<string, unknown>

describe('unwireAgent', () => {
  let home: string
  let sqlite: Database.Database
  let store: SecretStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-unwire-'))
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, generateMasterKey())
  })
  afterEach(() => {
    sqlite.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('Claude Code (JSON): removes mcpServers.foreman and its hook, keeping everything else and the file mode', () => {
    const entry = bundled('claude-code', home)
    const claudeJson = join(home, '.claude.json')
    const settings = join(home, '.claude', 'settings.json')
    writeFileSync(
      claudeJson,
      JSON.stringify({ numStartups: 3, mcpServers: { github: { command: 'npx', args: ['gh-mcp'] } } }, null, 2),
    )
    mkdirSync(join(home, '.claude'))
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }
    writeFileSync(settings, JSON.stringify({ env: { A: '1' }, hooks: { PreToolUse: [userHook] } }, null, 2))
    rewireAgent(store, 'claude-code', entry)
    installPreToolUseHook({ settingsPath: settings, hookCommand: 'foreman hook claude-code' })
    chmodSync(claudeJson, 0o640)
    chmodSync(settings, 0o644)

    const result = unwireAgent('claude-code', entry)

    expect(result.removed).toEqual([
      `mcpServers.foreman from ${claudeJson}`,
      `Foreman's PreToolUse hook from ${settings}`,
    ])
    expect(result.notes).toEqual([])
    const doc = JSON.parse(readFileSync(claudeJson, 'utf-8')) as Doc
    expect(doc).toEqual({ numStartups: 3, mcpServers: { github: { command: 'npx', args: ['gh-mcp'] } } })
    const s = JSON.parse(readFileSync(settings, 'utf-8')) as { env: Doc; hooks: { PreToolUse: unknown[] } }
    expect(s.env).toEqual({ A: '1' })
    expect(s.hooks.PreToolUse).toEqual([userHook])
    expect(readFileSync(settings, 'utf-8')).not.toContain(FOREMAN_HOOK_MARKER)
    expect(mode(claudeJson)).toBe(0o640)
    expect(mode(settings)).toBe(0o644)

    // Running it again finds nothing and changes nothing.
    const before = readFileSync(claudeJson, 'utf-8')
    expect(unwireAgent('claude-code', entry)).toEqual({ removed: [], notes: [] })
    expect(readFileSync(claudeJson, 'utf-8')).toBe(before)
  })

  it('drops an mcpServers map left empty, and leaves another agent\'s hook', () => {
    const entry = bundled('claude-code', home)
    const claudeJson = join(home, '.claude.json')
    const settings = join(home, '.claude', 'settings.json')
    writeFileSync(claudeJson, '{"theme":"dark"}')
    rewireAgent(store, 'cc-work', entry)
    installPreToolUseHook({ settingsPath: settings, hookCommand: 'foreman-hook claude-code' })

    const result = unwireAgent('cc-work', entry)

    expect(result.removed).toEqual([`mcpServers.foreman from ${claudeJson}`])
    expect(JSON.parse(readFileSync(claudeJson, 'utf-8'))).toEqual({ theme: 'dark' })
    // The hook runs for `claude-code`, still registered: it stays.
    expect(readFileSync(settings, 'utf-8')).toContain(FOREMAN_HOOK_MARKER)
  })

  it('leaves a foreman entry wired for another agent, and says so', () => {
    const entry = bundled('claude-code', home)
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, '{}')
    rewireAgent(store, 'claude-code', entry)
    const before = readFileSync(claudeJson, 'utf-8')

    const result = unwireAgent('cc-old', entry)

    expect(result.removed).toEqual([])
    expect(result.notes).toEqual([`${claudeJson}: left mcpServers.foreman (not cc-old's Foreman wiring)`])
    expect(readFileSync(claudeJson, 'utf-8')).toBe(before)
  })

  it('Codex (TOML): removes [mcp_servers.foreman], keeping other servers and keys', () => {
    const entry = bundled('codex', home)
    const config = join(home, '.codex', 'config.toml')
    mkdirSync(join(home, '.codex'))
    writeFileSync(config, 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n')
    rewireAgent(store, 'codex', entry)
    expect((parseToml(readFileSync(config, 'utf-8')) as { mcp_servers: Doc }).mcp_servers.foreman).toBeDefined()

    const result = unwireAgent('codex', entry)

    expect(result.removed).toEqual([`mcp_servers.foreman from ${config}`])
    expect(parseToml(readFileSync(config, 'utf-8'))).toEqual({ model: 'gpt-5', mcp_servers: { docs: { command: 'docs-mcp' } } })
  })

  it('Hermes (YAML): removes mcp_servers.foreman, keeping other keys', () => {
    const entry = bundled('hermes', home)
    const config = join(home, '.hermes', 'config.yaml')
    mkdirSync(join(home, '.hermes'))
    writeFileSync(config, 'model: claude\nmcp_servers:\n  fs:\n    command: fs-mcp\n')
    rewireAgent(store, 'hermes', entry)

    const result = unwireAgent('hermes', entry)

    expect(result.removed).toEqual([`mcp_servers.foreman from ${config}`])
    expect(parseYaml(readFileSync(config, 'utf-8'))).toEqual({ model: 'claude', mcp_servers: { fs: { command: 'fs-mcp' } } })
  })

  it('ZeroClaw (TOML): removes the [[mcp.servers]] entry, the foreman bundle and its grants', () => {
    const entry = bundled('zeroclaw', home)
    const config = join(home, '.zeroclaw', 'config.toml')
    mkdirSync(join(home, '.zeroclaw'))
    writeFileSync(
      config,
      '[[mcp.servers]]\nname = "git"\ncommand = "git-mcp"\n\n[mcp_bundles.dev]\nservers = ["git"]\n\n' +
        '[agents.main]\nmodel = "m"\nmcp_bundles = ["dev"]\n',
    )
    rewireAgent(store, 'zeroclaw', entry)
    const wired = parseToml(readFileSync(config, 'utf-8')) as { agents: { main: { mcp_bundles: string[] } } }
    expect(wired.agents.main.mcp_bundles).toEqual(['dev', 'foreman'])

    const result = unwireAgent('zeroclaw', entry)

    expect(result.removed).toEqual([
      `[[mcp.servers]] foreman from ${config}`,
      `mcp_bundles.foreman from ${config}`,
      `agents.main.mcp_bundles "foreman" from ${config}`,
    ])
    expect(parseToml(readFileSync(config, 'utf-8'))).toEqual({
      mcp: { servers: [{ name: 'git', command: 'git-mcp' }] },
      mcp_bundles: { dev: { servers: ['git'] } },
      agents: { main: { model: 'm', mcp_bundles: ['dev'] } },
    })
  })

  it('ZeroClaw: keeps a foreman bundle that lists your own servers too', () => {
    const entry = bundled('zeroclaw', home)
    const config = join(home, '.zeroclaw', 'config.toml')
    mkdirSync(join(home, '.zeroclaw'))
    writeFileSync(config, '[mcp_bundles.foreman]\nservers = ["git"]\n\n[agents.main]\nmcp_bundles = []\n')
    rewireAgent(store, 'zeroclaw', entry)

    unwireAgent('zeroclaw', entry)

    expect(parseToml(readFileSync(config, 'utf-8'))).toEqual({
      mcp_bundles: { foreman: { servers: ['git'] } },
      agents: { main: { mcp_bundles: ['foreman'] } },
    })
  })

  it('OpenClaw (nested JSON): removes mcp.servers.foreman', () => {
    const entry = bundled('openclaw', home)
    const config = join(home, '.openclaw', 'openclaw.json')
    mkdirSync(join(home, '.openclaw'))
    writeFileSync(config, JSON.stringify({ gateway: { port: 1 }, mcp: { servers: { web: { command: 'web' } } } }))
    rewireAgent(store, 'openclaw', entry)

    const result = unwireAgent('openclaw', entry)

    expect(result.removed).toEqual([`mcp.servers.foreman from ${config}`])
    expect(JSON.parse(readFileSync(config, 'utf-8'))).toEqual({ gateway: { port: 1 }, mcp: { servers: { web: { command: 'web' } } } })
  })

  it('is best-effort: a missing config is fine, an unparsable one is reported and left alone', () => {
    const entry = bundled('claude-code', home)
    expect(unwireAgent('claude-code', entry)).toEqual({ removed: [], notes: [] })
    expect(existsSync(join(home, '.claude.json'))).toBe(false)

    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, '{"mcpServers": {"foreman": {"env": {"FOREMAN_AGENT_TOKEN": "fat_secret"')
    const result = unwireAgent('claude-code', entry)
    expect(result.removed).toEqual([])
    expect(result.notes).toEqual([`${claudeJson} doesn't parse as JSON; nothing removed from it`])
    expect(result.notes.join(' ')).not.toContain('fat_secret')
    expect(readFileSync(claudeJson, 'utf-8')).toContain('fat_secret')
  })

  it('never follows a symlink', () => {
    const entry = bundled('claude-code', home)
    const real = join(home, 'real.json')
    writeFileSync(real, '{}')
    rewireAgent(store, 'claude-code', entry, { configPath: real })
    const before = readFileSync(real, 'utf-8')
    const claudeJson = join(home, '.claude.json')
    symlinkSync(real, claudeJson)

    const result = unwireAgent('claude-code', entry)

    expect(result.removed).toEqual([])
    expect(result.notes[0]).toContain(`${claudeJson} is a symlink; Foreman left it alone`)
    expect(lstatSync(claudeJson).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf-8')).toBe(before)
  })

  it('does nothing without a registry entry or config path', () => {
    expect(unwireAgent('custom', null)).toEqual({ removed: [], notes: [] })
    expect(unwireAgent('generic', findAgent(loadBundledRegistry(), 'generic-mcp'))).toEqual({ removed: [], notes: [] })
  })
})
