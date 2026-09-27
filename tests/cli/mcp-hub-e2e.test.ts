import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// End to end: agent → `foreman mcp-stdio` → mediator → MCP hub → a real
// upstream MCP server, with the audit log checked afterwards.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FM_BIN = join(ROOT, 'dist/cli/index.js')
const DEMO = join(ROOT, 'tests/core/mcp-hub/fixtures/demo-server.mjs')

interface Rpc {
  id: number
  result?: { content?: Array<{ type: string; text?: string }>; tools?: Array<{ name: string }>; isError?: boolean }
  error?: { message: string }
}

class Session {
  private buf = ''
  private waiters = new Map<number, (r: Rpc) => void>()
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString()
      let nl: number
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(this.buf.slice(0, nl)) as Rpc
        this.buf = this.buf.slice(nl + 1)
        this.waiters.get(msg.id)?.(msg)
      }
    })
  }
  call(id: number, method: string, params: unknown = {}): Promise<Rpc> {
    const done = new Promise<Rpc>((r) => this.waiters.set(id, r))
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return done
  }
  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('exit', r))
  }
}

describe('MCP hub through foreman mcp-stdio', () => {
  let home: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-hub-e2e-'))
    env = {
      ...process.env,
      FOREMAN_HOME: home,
      FOREMAN_NO_UPDATE_CHECK: '1',
      FOREMAN_APPROVAL_TIMEOUT: '1',
    }
    spawnSync('node', [FM_BIN, 'init'], { env, encoding: 'utf-8' })
    writeFileSync(
      join(home, 'mcp.yaml'),
      [
        'servers:',
        '  demo:',
        `    command: ${JSON.stringify(process.execPath)}`,
        `    args: [${JSON.stringify(DEMO)}]`,
        '    tools:',
        '      allow: [echo]',
        '      deny: ["delete_*"]',
        '',
      ].join('\n'),
    )
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists hub tools, runs policy-allowed calls, gates the rest, and audits both', async () => {
    const s = new Session(spawn('node', [FM_BIN, 'mcp-stdio', '--source', 'claude-code'], { env }))
    await s.call(1, 'initialize')
    const list = await s.call(2, 'tools/list')
    const names = list.result!.tools!.map((t) => t.name)
    expect(names).toContain('secrets/get') // Foreman's own tools stay
    expect(names).toContain('demo__echo')
    expect(names).not.toContain('demo__delete_everything')

    const echo = await s.call(3, 'tools/call', { name: 'demo__echo', arguments: { text: 'hello hub' } })
    expect(echo.result!.content![0]!.text).toBe('hello hub')

    // No policy / mcp.yaml rule → ask → nobody answers within 1 s → denied.
    const gated = await s.call(4, 'tools/call', { name: 'demo__read_config', arguments: {} })
    expect(gated.error?.message).toContain("Denied by approval-timeout")

    const hidden = await s.call(5, 'tools/call', { name: 'demo__delete_everything', arguments: {} })
    expect(hidden.result!.isError).toBe(true)
    await s.close()

    const log = spawnSync('node', [FM_BIN, 'log', 'tail', '--json'], { env, encoding: 'utf-8' }).stdout
    expect(log).toContain('demo__echo')
    expect(log).toContain('demo__read_config')
  }, 30_000)

  it('`foreman mcp tools` shows the inventory with the deny rule applied', () => {
    const out = spawnSync('node', [FM_BIN, 'mcp', 'tools', '--json'], { env, encoding: 'utf-8' })
    const parsed = JSON.parse(out.stdout) as { tools: Array<{ name: string; status: string }> }
    const byName = Object.fromEntries(parsed.tools.map((t) => [t.name, t.status]))
    expect(byName.echo).toBe('available')
    expect(byName.delete_everything).toBe('denied')
  }, 30_000)

  it('`foreman mcp add` writes mcp.yaml and lists required secrets', () => {
    const out = spawnSync('node', [FM_BIN, 'mcp', 'add', 'github'], { env, encoding: 'utf-8' })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('foreman secrets add github-pat')
    const listed = spawnSync('node', [FM_BIN, 'mcp', 'list'], { env, encoding: 'utf-8' })
    expect(listed.stdout).toContain('github')
    expect(listed.stdout).toContain('missing secrets: github-pat')
  }, 30_000)
})
