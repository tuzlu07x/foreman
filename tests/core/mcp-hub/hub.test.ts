import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubConfigSchema, type HubConfig } from '../../../src/core/mcp-hub/config.js'
import {
  CALL_TOOL,
  HubToolUnavailableError,
  McpHub,
  SEARCH_TOOL,
} from '../../../src/core/mcp-hub/hub.js'
import { ToolPinStore } from '../../../src/core/mcp-hub/pins.js'
import { INJECTION_WARNING } from '../../../src/core/mcp-hub/result-guard.js'

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/demo-server.mjs')

function config(overrides: Record<string, unknown> = {}, variant = 'clean'): HubConfig {
  return HubConfigSchema.parse({
    servers: {
      demo: {
        command: process.execPath,
        args: [DEMO],
        env: { DEMO_VARIANT: variant },
        tools: { allow: ['echo'], deny: ['delete_*'] },
      },
    },
    ...overrides,
  })
}

describe('McpHub against a real stdio MCP server', () => {
  let dir: string
  let pinsPath: string
  const hubs: McpHub[] = []

  function hub(cfg: HubConfig, extra: { resolveSecret?: (n: string) => string | null } = {}): McpHub {
    const h = new McpHub({
      config: cfg,
      resolveSecret: extra.resolveSecret ?? (() => null),
      pins: new ToolPinStore(pinsPath),
    })
    hubs.push(h)
    return h
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-hub-'))
    pinsPath = join(dir, 'mcp-pins.json')
  })
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.close()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists namespaced tools, hides denied ones, and pins definitions on first use', async () => {
    const tools = await hub(config()).listForAgent()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['demo__big_report', 'demo__echo', 'demo__read_config'])
    const pins = JSON.parse(readFileSync(pinsPath, 'utf-8'))
    expect(Object.keys(pins.servers.demo.tools).sort()).toContain('delete_everything')
  })

  it('serves later listings from the pinned cache without spawning the server', async () => {
    await hub(config()).listForAgent()
    const second = hub(config())
    await second.listForAgent()
    expect(second.status()[0]!.source).toBe('pinned-cache')
  })

  it('executes an allowed call through the upstream and guards the result', async () => {
    const h = hub(config())
    const resolution = await h.resolveCall('demo__read_config', {})
    expect(resolution?.kind).toBe('tool')
    if (resolution?.kind !== 'tool') return
    const { result, stats } = await h.call(resolution.tool, resolution.args)
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n')
    expect(text).not.toContain(`ghp_${'a'.repeat(36)}`)
    expect(text).toContain('[REDACTED')
    expect(text.startsWith(INJECTION_WARNING)).toBe(true)
    expect(stats.redactions).toBe(1)
    expect(stats.injectionFlags.length).toBeGreaterThan(0)
  })

  it('truncates oversized results to the configured budget', async () => {
    const h = hub(config({ limits: { max_result_chars: 2_000 } }))
    const resolution = await h.resolveCall('demo__big_report', {})
    if (resolution?.kind !== 'tool') throw new Error('expected tool')
    const { result, stats } = await h.call(resolution.tool, resolution.args)
    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBeLessThan(2_200)
    expect(text).toContain('truncated by Foreman')
    expect(stats.truncatedChars).toBe(48_000)
  })

  it('quarantines a poisoned tool definition (tool poisoning)', async () => {
    const tools = await hub(config({}, 'poisoned')).inventory()
    const add = tools.find((t) => t.name === 'add')!
    expect(add.status).toBe('quarantined')
    expect(add.reasons.join(' ')).toMatch(/suspicious definition/)
    const resolution = await hub(config({}, 'poisoned')).resolveCall('demo__add', { a: 1, b: 2 })
    expect(resolution?.kind).toBe('unavailable')
  })

  it('detects a rug pull: a changed definition is withheld until trusted', async () => {
    await hub(config()).listForAgent() // pins the clean definitions
    const changed = config({}, 'changed')
    // Same launch command → same fingerprint; the definition differs.
    changed.servers.demo!.env = { DEMO_VARIANT: 'changed' }
    const h = hub(changed)
    // Cached listing still shows echo, but calling it verifies live first.
    const resolution = await h.resolveCall('demo__echo', { text: 'x' })
    if (resolution?.kind !== 'tool') throw new Error('expected tool')
    await expect(h.call(resolution.tool, resolution.args)).rejects.toBeInstanceOf(HubToolUnavailableError)
    const fresh = await hub(changed).inventory({ refresh: true })
    expect(fresh.find((t) => t.name === 'echo')!.reasons.join(' ')).toMatch(/rug pull/)
    await hub(changed).trust('demo')
    const trusted = await hub(changed).inventory({ refresh: true })
    expect(trusted.find((t) => t.name === 'echo')!.status).toBe('available')
  })

  it('remembers a detected rug pull, so the cached listing shows it too (#634)', async () => {
    await hub(config()).listForAgent() // pins the clean definitions
    const changed = config({}, 'changed')
    changed.servers.demo!.env = { DEMO_VARIANT: 'changed' }
    const h = hub(changed)
    const resolution = await h.resolveCall('demo__echo', { text: 'x' })
    if (resolution?.kind !== 'tool') throw new Error('expected tool')
    await expect(h.call(resolution.tool, resolution.args)).rejects.toThrow(/--refresh/)
    // A later listing from the pinned cache (what `foreman mcp tools demo`
    // shows) no longer claims echo is available.
    const cached = hub(changed)
    const tools = await cached.inventory()
    expect(cached.status()[0]!.source).toBe('pinned-cache')
    const echo = tools.find((t) => t.name === 'echo')!
    expect(echo.status).toBe('quarantined')
    expect(echo.reasons.join(' ')).toMatch(/rug pull; seen \d{4}-\d{2}-\d{2}/)
    expect((await cached.listForAgent()).map((t) => t.name)).not.toContain('demo__echo')
    // Trusting the new definitions clears it.
    await hub(changed).trust('demo')
    const trusted = await hub(changed).inventory()
    expect(trusted.find((t) => t.name === 'echo')!.status).toBe('available')
    expect(JSON.parse(readFileSync(pinsPath, 'utf-8')).servers.demo.drift).toBeUndefined()
  })

  it('lists tools that appeared since pinning even from the cache (#634)', async () => {
    await hub(config()).listForAgent()
    await hub(config({}, 'extra')).inventory({ refresh: true })
    const cached = hub(config({}, 'extra'))
    await cached.inventory()
    expect(cached.status()[0]!.newSincePinning).toEqual(['new_tool'])
  })

  it('quarantines tools that appear after pinning', async () => {
    await hub(config()).listForAgent()
    const tools = await hub(config({}, 'extra')).inventory({ refresh: true })
    expect(tools.find((t) => t.name === 'new_tool')!.reasons.join(' ')).toMatch(/after the server was pinned/)
  })

  it('switches to lazy discovery above the threshold and routes foreman_call_tool', async () => {
    const h = hub(config({ limits: { lazy_threshold: 1 } }))
    const listing = await h.listForAgent()
    expect(listing.map((t) => t.name)).toEqual([SEARCH_TOOL, CALL_TOOL])
    const found = await h.search('echo text', 3)
    expect(found[0]!.name).toBe('demo__echo')
    const resolution = await h.resolveCall(CALL_TOOL, { name: 'demo__echo', arguments: { text: 'hi' } })
    if (resolution?.kind !== 'tool') throw new Error('expected tool')
    const { result } = await h.call(resolution.tool, resolution.args)
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('scrubs injected secrets from an upstream start-up error', async () => {
    const cfg = HubConfigSchema.parse({
      servers: {
        leaky: {
          command: process.execPath,
          args: ['-e', 'console.error("rejected token " + process.env.TOKEN); process.exit(1)'],
          env: { TOKEN: '${secret:leaky-token}' },
        },
      },
    })
    const h = hub(cfg, { resolveSecret: (n) => (n === 'leaky-token' ? 'hunter2hunter2' : null) })
    await h.inventory({ refresh: true })
    const [status] = h.status()
    expect(status!.source).toBe('unavailable')
    expect(status!.error).toContain('rejected token [redacted]')
    expect(status!.error).not.toContain('hunter2hunter2')
  })

  it('honours an org scope: servers outside the role are invisible and refused', async () => {
    const h = hub(config())
    const scope = { allowedServers: new Set(['github']) }
    expect(await h.listForAgent(scope)).toEqual([])
    const r = await h.resolveCall('demo__echo', { text: 'x' }, scope)
    expect(r).toMatchObject({ kind: 'unavailable' })
  })

  it('reports a missing secret without taking other servers down', async () => {
    const cfg = HubConfigSchema.parse({
      servers: {
        demo: { command: process.execPath, args: [DEMO], tools: { allow: ['echo'] } },
        needs: { command: process.execPath, args: [DEMO], env: { TOKEN: '${secret:absent-token}' } },
      },
    })
    const h = hub(cfg)
    const names = (await h.listForAgent()).map((t) => t.name)
    expect(names).toContain('demo__echo')
    const needs = h.status().find((s) => s.name === 'needs')!
    expect(needs.source).toBe('unavailable')
    expect(needs.error).toMatch(/foreman secrets add absent-token/)
  })

  it('resolves ${secret:…} references into the child environment only', async () => {
    const cfg = HubConfigSchema.parse({
      servers: { demo: { command: process.execPath, args: [DEMO], env: { DEMO_VARIANT: '${secret:variant}' } } },
    })
    const tools = await hub(cfg, { resolveSecret: (n) => (n === 'variant' ? 'poisoned' : null) }).inventory()
    expect(tools.map((t) => t.name)).toContain('add')
    // The secret value never lands in mcp-pins.json.
    expect(readFileSync(pinsPath, 'utf-8')).not.toContain('"poisoned"')
  })

  it('returns null for names that are not hub tools', async () => {
    expect(await hub(config()).resolveCall('read_file', {})).toBeNull()
  })
})
