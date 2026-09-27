import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #618 end to end: `foreman mcp-stdio --source <id>` is that agent only with
// the agent's token in FOREMAN_AGENT_TOKEN. Checked through the org role (a
// department channel only codex's role may post to), with real processes.

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
  async post(to: string, text: string): Promise<string> {
    const res = await this.request('tools/call', { name: 'org_post', arguments: { to, text } })
    return res.result?.content?.[0]?.text ?? res.error?.message ?? ''
  }
  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('exit', r))
  }
}

describe('foreman mcp-stdio agent identity', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  let token: string
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  const connect = async (extra: NodeJS.ProcessEnv = {}): Promise<Session> => {
    const s = new Session(spawn('node', [FM_BIN, 'mcp-stdio', '--source', 'codex'], { env: { ...env, ...extra } }))
    await s.request('initialize')
    return s
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-mcp-identity-'))
    env = { ...process.env, FOREMAN_HOME: home, FOREMAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }
    delete env.FOREMAN_AGENT_TOKEN
    run('init')
    run('org', 'init', '--template', 'startup')
    const tokenFile = join(home, 'codex.token')
    run('agent', 'add', 'codex', '--type', 'generic-mcp', '--skip-config', '--token-out', tokenFile)
    token = readFileSync(tokenFile, 'utf-8').trim()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('with its token, codex holds its org role', async () => {
    const s = await connect({ FOREMAN_AGENT_TOKEN: token })
    expect(await s.post('engineering', 'tests are green')).toMatch(/^Posted to #engineering/)
    await s.close()
    expect(s.stderr).toBe('')
  }, 20_000)

  it('claiming codex without the token runs as untrusted:codex, loudly, and never echoes a token', async () => {
    const s = await connect({ FOREMAN_AGENT_TOKEN: 'fat_guessed' })
    expect(await s.post('engineering', 'ship it')).toContain('Not sent')
    await s.close()
    expect(s.stderr).toContain('untrusted:codex')
    expect(s.stderr).toContain('foreman agent rewire codex')
    expect(s.stderr).not.toContain('fat_guessed')
    const inbox = run('inbox', '--json').stdout
    expect(inbox).toContain('codex is connected without a valid agent token')
    expect(inbox).not.toContain(token)
  }, 20_000)

  it('rotating the token drops a connected session to untrusted at once', async () => {
    const s = await connect({ FOREMAN_AGENT_TOKEN: token })
    expect(await s.post('engineering', 'before')).toMatch(/^Posted/)
    const rotated = run('agent', 'token', 'rotate', 'codex', '--yes', '--token-out', join(home, 'codex2.token'))
    expect(rotated.status).toBe(0)
    expect(rotated.stdout + rotated.stderr).not.toContain(token)
    expect(await s.post('engineering', 'after')).toContain('Not sent')
    await s.close()
    expect(s.stderr).toContain('untrusted:codex')

    const fresh = await connect({ FOREMAN_AGENT_TOKEN: readFileSync(join(home, 'codex2.token'), 'utf-8').trim() })
    expect(await fresh.post('engineering', 'back')).toMatch(/^Posted/)
    await fresh.close()
  }, 30_000)

  it('doctor warns about agents without a token and points at rewire', () => {
    run('agent', 'add', 'openclaw', '--type', 'generic-mcp', '--skip-config')
    const doctor = run('doctor', '--json')
    const check = (JSON.parse(doctor.stdout) as { checks: Array<{ name: string; status: string; message: string; remediation?: string }> }).checks.find(
      (c) => c.name === 'agent_tokens',
    )
    expect(check).toMatchObject({ status: 'warn' })
    expect(check!.message).toContain('openclaw')
    expect(check!.remediation).toContain('foreman agent rewire openclaw')
  }, 20_000)
})
