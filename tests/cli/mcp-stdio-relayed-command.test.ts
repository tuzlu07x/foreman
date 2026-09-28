import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #656 (H1), with real processes: a verified agent used to shut Foreman
// down and switch its LLM through `submit_command` (the owner check took
// the agent's word, or fell back to the stored chat id). A command that
// changes Foreman now runs only once a person allows it.

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
  async command(command: string, args: string[] = []): Promise<Rpc> {
    return this.request('tools/call', { name: 'submit_command', arguments: { command, args, source_user: '4242' } })
  }
  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('exit', r))
  }
}

const text = (r: Rpc): string => r.result?.content?.[0]?.text ?? r.error?.message ?? ''

describe('foreman mcp-stdio submit_command from a verified agent (#656)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  let token: string
  const run = (args: string[], input?: string) =>
    spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8', ...(input !== undefined ? { input } : {}) })
  const connect = async (extra: NodeJS.ProcessEnv = {}): Promise<Session> => {
    const s = new Session(
      spawn('node', [FM_BIN, 'mcp-stdio', '--source', 'hermes'], { env: { ...env, FOREMAN_AGENT_TOKEN: token, ...extra } }),
    )
    await s.request('initialize')
    return s
  }
  const db = (): Database.Database => new Database(join(home, 'foreman.db'))
  const queued = (): Array<{ command: string; source_user: string | null }> => {
    const d = db()
    const rows = d.prepare('SELECT command, source_user FROM control_commands ORDER BY id').all() as Array<{
      command: string
      source_user: string | null
    }>
    d.close()
    return rows
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-relayed-cmd-'))
    env = { ...process.env, FOREMAN_HOME: home, HOME: home, FOREMAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }
    delete env.FOREMAN_AGENT_TOKEN
    run(['init'])
    // The owner's chat id is on file, as after the setup wizard: the old
    // owner check fell back to it when the agent sent no user id.
    run(['secrets', 'add', 'telegram-chat-id'], '4242\n')
    const tokenFile = join(home, 'hermes.token')
    run(['agent', 'add', 'hermes', '--type', 'generic-mcp', '--skip-config', '--token-out', tokenFile])
    token = readFileSync(tokenFile, 'utf-8').trim()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('the QA repro: `model` and `stop` are refused when nobody allows them, and nothing changes', async () => {
    const llm = (): string | null => (existsSync(join(home, 'llm.yaml')) ? readFileSync(join(home, 'llm.yaml'), 'utf-8') : null)
    const llmBefore = llm()
    const s = await connect({ FOREMAN_APPROVAL_TIMEOUT: '1' })
    const model = await s.command('model', ['claude-opus-4'])
    const stop = await s.command('stop')
    // Read-only commands still answer at once.
    const status = await s.command('status')
    await s.close()
    for (const r of [model, stop]) {
      expect(r.result?.isError).toBe(true)
      expect(text(r)).toContain("needs the user's OK in Foreman")
    }
    expect(status.result?.isError).toBeFalsy()
    expect(text(status)).toMatch(/agents? registered/)
    expect(queued()).toEqual([])
    expect(llm()).toBe(llmBefore)
    const d = db()
    const refused = d
      .prepare("SELECT payload FROM audit_events WHERE event_type = 'foreman:command-refused' ORDER BY id")
      .all() as Array<{ payload: string }>
    const asked = d
      .prepare("SELECT decision, decided_by FROM requests WHERE target_tool = 'foreman_command' ORDER BY created_at")
      .all() as Array<{ decision: string; decided_by: string }>
    d.close()
    expect(refused.map((r) => (JSON.parse(r.payload) as { command: string }).command)).toEqual(['model', 'stop'])
    expect(asked).toEqual([
      { decision: 'denied', decided_by: 'approval-timeout' },
      { decision: 'denied', decided_by: 'approval-timeout' },
    ])
  }, 30_000)

  it("a `write` is the agent's own delegation: queued, but never in the owner's name", async () => {
    run(['agent', 'add', 'codex', '--type', 'generic-mcp', '--skip-config'])
    const s = await connect()
    const res = await s.command('write', ['codex', 'review', 'the', 'parser'])
    await s.close()
    expect(res.result?.isError).toBeFalsy()
    // The agent sent the owner's id as source_user; it is not taken.
    expect(queued()).toEqual([{ command: 'write', source_user: null }])
  }, 30_000)

  it('runs once the user allows it in Foreman, attributed to the owner', async () => {
    const s = await connect()
    const pending = s.command('stop')
    // Stand in for the TUI: allow the approval the relay is waiting on.
    const d = db()
    let row: { request_id: string; args: string } | undefined
    for (let i = 0; i < 100 && !row; i++) {
      row = d
        .prepare("SELECT request_id, args FROM pending_approvals WHERE target_tool = 'foreman_command' AND status = 'pending'")
        .get() as typeof row
      if (!row) await new Promise((r) => setTimeout(r, 100))
    }
    expect(row).toBeDefined()
    expect(JSON.parse(row!.args)).toEqual({ command: 'stop', args: [] })
    d.prepare(
      "UPDATE pending_approvals SET status = 'resolved', decision = 'allowed', resolved_by = 'user', resolved_via = 'tui', resolved_at = ? WHERE request_id = ?",
    ).run(Date.now(), row!.request_id)
    d.close()
    const answer = await pending
    await s.close()
    expect(answer.result?.isError).toBeFalsy()
    expect(text(answer)).toMatch(/Shutdown queued/)
    expect(queued()).toEqual([{ command: 'stop', source_user: '4242' }])
  }, 30_000)
})
