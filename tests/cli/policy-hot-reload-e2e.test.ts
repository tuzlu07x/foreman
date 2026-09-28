import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #656 (M5) with real processes: a running `foreman mcp-stdio` applies a
// policy.yaml edit on its next call, and rule ids survive other processes
// re-reading the file.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

class Session {
  private buf = ''
  stderr = ''
  private waiters = new Map<number, (r: { result?: { content?: Array<{ text?: string }> }; error?: { message: string } }) => void>()
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
    child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()))
  }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const id = this.next++
    const done = new Promise<{ result?: { content?: Array<{ text?: string }> }; error?: { message: string } }>((r) =>
      this.waiters.set(id, r),
    )
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
    const res = await done
    return res.result?.content?.[0]?.text ?? res.error?.message ?? ''
  }
  async close(): Promise<void> {
    this.child.stdin.end()
    await new Promise((r) => this.child.on('exit', r))
  }
}

const rules = (effect: string) => `rules:
  - source: qa-bot
    target: tool:list_files
    effect: ${effect}
`

describe('policy.yaml edits reach running processes (#656)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  let token: string
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  const writePolicy = (text: string, bump: number) => {
    const p = join(home, 'policy.yaml')
    writeFileSync(p, text)
    const t = new Date(Date.now() + bump * 1000)
    utimesSync(p, t, t)
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-policy-e2e-'))
    env = { ...process.env, FOREMAN_HOME: home, HOME: home, FOREMAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }
    delete env.FOREMAN_AGENT_TOKEN
    run('init')
    run('agent', 'add', 'qa-bot', '--type', 'generic-mcp', '--skip-config', '--token-out', join(home, 't'))
    token = readFileSync(join(home, 't'), 'utf-8').trim()
    writePolicy(rules('allow'), 1)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('an edit applies on the next call; a broken edit keeps the last good policy', async () => {
    const s = new Session(
      spawn('node', [FM_BIN, 'mcp-stdio', '--source', 'qa-bot'], { env: { ...env, FOREMAN_AGENT_TOKEN: token } }),
    )
    const allowed = await s.call('list_files', { path: '.' })
    expect(allowed).toMatch(/allowed by policy:\d+/)
    writePolicy(rules('deny'), 2)
    await new Promise((r) => setTimeout(r, 400))
    expect(await s.call('list_files', { path: '.' })).toMatch(/^Denied by policy:\d+$/)
    writePolicy('- this is: [broken\n', 3)
    await new Promise((r) => setTimeout(r, 400))
    expect(await s.call('list_files', { path: '.' })).toMatch(/^Denied by policy:\d+$/)
    await s.close()
    expect(s.stderr).toMatch(/could not be applied/)
    expect(s.stderr.match(/could not be applied/g)).toHaveLength(1)
  }, 30_000)

  it('rule ids stay put when other processes re-read the file', () => {
    const ids = () =>
      (JSON.parse(run('policy', 'show', '--json').stdout) as { rules: Array<{ id: number }> }).rules.map((r) => r.id)
    const first = ids()
    expect(first.length).toBeGreaterThan(0)
    expect(ids()).toEqual(first)
    expect(ids()).toEqual(first)
  })
})
