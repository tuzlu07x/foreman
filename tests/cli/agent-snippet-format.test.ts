import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMcpSnippet, snippetForDisplay } from '../../src/core/agent-mcp-snippet.js'
import { findAgent, loadBundledRegistry } from '../../src/core/registry-catalog.js'
import { stubInstallers } from '../support/stub-installers.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 L32 — `agent add` and `agent show` printed the MCP snippet as
// YAML (`mcpServers:`), though the config it goes in (and MCP clients in
// general) read JSON.
describe('MCP snippet format', () => {
  const doc = loadBundledRegistry()
  const shown = (id: string, path: string | null) => snippetForDisplay(buildMcpSnippet(id, findAgent(doc, id)), path)

  it('is JSON for a JSON config and for a custom MCP client', () => {
    const claude = shown('claude-code', '/home/u/.claude.json')
    expect(claude.format).toBe('json')
    expect(JSON.parse(claude.text)).toEqual({
      mcpServers: {
        foreman: { command: 'foreman', args: ['mcp-stdio', '--source', 'claude-code'], env: { FOREMAN_AGENT_TOKEN: expect.any(String) } },
      },
    })
    expect(shown('generic-mcp', null).format).toBe('json')
    expect(() => JSON.parse(shown('generic-mcp', null).text)).not.toThrow()
  })

  it('is TOML for Codex and YAML for Hermes', () => {
    const codex = shown('codex', '/home/u/.codex/config.toml')
    expect(codex.format).toBe('toml')
    expect(parseToml(codex.text)).toHaveProperty('mcp_servers.foreman.command', 'foreman')
    expect(shown('hermes', '/home/u/.hermes/config.yaml').format).toBe('yaml')
  })
})

describe('foreman agent show / add print that format', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-snippet-'))
    env = { HOME: join(dir, 'home'), FOREMAN_HOME: join(dir, 'fh'), TMPDIR: dir, PATH: stubInstallers(dir).path, NO_COLOR: '1', FOREMAN_NO_UPDATE_CHECK: '1' }
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('shows JSON for claude-code, and for generic-mcp at add time', () => {
    expect(run('agent', 'add', 'claude-code', '--skip-config').status).toBe(0)
    const show = run('agent', 'show', 'claude-code').stdout
    expect(show).toContain('MCP snippet (json, for ')
    expect(show).toContain('"mcpServers": {')
    expect(show).not.toMatch(/^mcpServers:/m)
    const add = run('agent', 'add', 'my-mcp', '--type', 'generic-mcp').stdout
    expect(add).toContain('"mcpServers": {')
    expect(add).not.toMatch(/^mcpServers:/m)
  })
})
