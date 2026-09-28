import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #656 (A) with real processes: a hand-off from one agent to another is
// checked against `can_call` / `cannot_call`, over MCP and from a shell
// Foreman spawned for the agent.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

class Session {
  private buf = ''
  private waiters = new Map<number, (r: { result?: { content?: Array<{ text?: string }>; isError?: boolean } }) => void>()
  private next = 1
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString()
      let nl: number
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(this.buf.slice(0, nl))
        this.buf = this.buf.slice(nl + 1)
        this.waiters.get(msg.id)?.(msg)
      }
    })
  }
  async write(target: string, task: string): Promise<{ text: string; isError: boolean }> {
    const id = this.next++
    const done = new Promise<{ result?: { content?: Array<{ text?: string }>; isError?: boolean } }>((r) => this.waiters.set(id, r))
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'submit_command', arguments: { command: 'write', args: [target, ...task.split(' ')] } } })}\n`,
    )
    const res = await done
    return { text: res.result?.content?.[0]?.text ?? '', isError: res.result?.isError === true }
  }
  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('exit', r))
  }
}

describe('agent-to-agent hand-offs follow can_call / cannot_call (#656)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  let token: string
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync('node', [FM_BIN, ...args], { env: { ...env, ...extra }, encoding: 'utf-8' })
  const queued = (): string[] => {
    const db = new Database(join(home, 'foreman.db'), { readonly: true })
    const rows = db.prepare("SELECT args FROM control_commands WHERE command = 'write' ORDER BY id").all() as Array<{ args: string }>
    db.close()
    return rows.map((r) => (JSON.parse(r.args) as string[])[0]!)
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-a2a-'))
    env = { ...process.env, FOREMAN_HOME: home, HOME: home, FOREMAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1', FOREMAN_APPROVAL_TIMEOUT: '1' }
    delete env.FOREMAN_AGENT_TOKEN
    delete env.FOREMAN_SPAWNED_BY
    run(['init'])
    run(['agent', 'add', 'hermes', '--type', 'generic-mcp', '--skip-config', '--token-out', join(home, 't')])
    run(['agent', 'add', 'codex', '--type', 'generic-mcp', '--skip-config'])
    run(['agent', 'add', 'openclaw', '--type', 'generic-mcp', '--skip-config'])
    token = readFileSync(join(home, 't'), 'utf-8').trim()
    writeFileSync(join(home, 'policy.yaml'), 'agents:\n  hermes:\n    cannot_call:\n      codex: [write]\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('over MCP: cannot_call refuses the hand-off, others still go through', async () => {
    const s = new Session(
      spawn('node', [FM_BIN, 'mcp-stdio', '--source', 'hermes'], { env: { ...env, FOREMAN_AGENT_TOKEN: token } }),
    )
    const refused = await s.write('codex', 'delete the repo')
    const allowed = await s.write('openclaw', 'draft the release notes')
    await s.close()
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^Not handed to codex: denied by policy:\d+\.$/)
    expect(allowed.isError).toBe(false)
    expect(queued()).toEqual(['openclaw'])
  }, 30_000)

  it('from a shell Foreman spawned for the agent', () => {
    const refused = run(['write', 'codex', 'delete the repo'], { FOREMAN_SPAWNED_BY: 'hermes' })
    expect(refused.status).toBe(2)
    expect(refused.stderr).toMatch(/not handed to codex: denied by policy:\d+/)
    // You, at the terminal, are not an agent: no agent rule applies.
    expect(run(['write', 'codex', 'review the parser']).status).toBe(0)
    expect(queued()).toEqual(['codex'])
  }, 30_000)
})
