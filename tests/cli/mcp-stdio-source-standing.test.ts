import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #656 (M1): a connection's `--source` never creates a registry row, a
// block holds whatever the case of the claimed id, and a removed agent
// stays removed when its client reconnects with a token left behind.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

interface Rpc {
  id: number
  result?: { content?: Array<{ text?: string }>; isError?: boolean }
  error?: { message: string }
}

class Session {
  private buf = ''
  stderr = ''
  private waiters = new Map<number, (r: Rpc) => void>()
  private next = 1
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
    child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()))
  }
  request(method: string, params: unknown = {}): Promise<Rpc> {
    const id = this.next++
    const done = new Promise<Rpc>((r) => this.waiters.set(id, r))
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return done
  }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args })
    return res.result?.content?.[0]?.text ?? res.error?.message ?? ''
  }
  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('exit', r))
  }
}

describe('foreman mcp-stdio — who a --source can be (#656)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  const connect = async (source: string, extra: NodeJS.ProcessEnv = {}): Promise<Session> => {
    const s = new Session(spawn('node', [FM_BIN, 'mcp-stdio', '--source', source], { env: { ...env, ...extra } }))
    await s.request('initialize')
    return s
  }
  const agentIds = (): string[] => {
    const db = new Database(join(home, 'foreman.db'), { readonly: true })
    const ids = (db.prepare('SELECT id FROM agents ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)
    db.close()
    return ids
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-mcp-standing-'))
    env = {
      ...process.env,
      FOREMAN_HOME: home,
      HOME: home,
      FOREMAN_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
      FOREMAN_APPROVAL_TIMEOUT: '1',
    }
    delete env.FOREMAN_AGENT_TOKEN
    run('init')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('a block on qa-bot holds for QA-BOT, and nothing registers the spelling', async () => {
    const tokenFile = join(home, 'qa-bot.token')
    expect(run('agent', 'add', 'qa-bot', '--type', 'generic-mcp', '--skip-config', '--token-out', tokenFile).status).toBe(0)
    expect(run('agent', 'block', 'qa-bot').status).toBe(0)
    const token = readFileSync(tokenFile, 'utf-8').trim()
    for (const extra of [{}, { FOREMAN_AGENT_TOKEN: token }]) {
      const s = await connect('QA-BOT', extra)
      expect(await s.call('list_files', { path: '.' })).toBe('Denied by agent:blocked')
      await s.close()
    }
    expect(agentIds()).toEqual(['qa-bot'])
  }, 30_000)

  it('an unknown --source creates no registry row', async () => {
    const s = await connect('nobody-registered')
    await s.call('list_files', { path: '.' })
    await s.close()
    expect(agentIds()).toEqual([])
  }, 20_000)

  it('a removed agent whose token was left behind reconnects untrusted and stays removed', async () => {
    const tokenFile = join(home, 'codex.token')
    run('agent', 'add', 'codex', '--type', 'generic-mcp', '--skip-config', '--token-out', tokenFile)
    const token = readFileSync(tokenFile, 'utf-8').trim()
    // The row goes, the stored token stays (a remove that couldn't revoke).
    const db = new Database(join(home, 'foreman.db'))
    db.prepare("DELETE FROM agents WHERE id = 'codex'").run()
    db.close()
    const s = await connect('codex', { FOREMAN_AGENT_TOKEN: token })
    await s.call('list_files', { path: '.' })
    await s.close()
    expect(s.stderr).toContain('untrusted:codex')
    expect(s.stderr).toContain('no longer registered')
    expect(s.stderr).not.toContain(token)
    expect(agentIds()).toEqual([])
  }, 20_000)
})
