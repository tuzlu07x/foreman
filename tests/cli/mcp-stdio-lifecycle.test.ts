import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Real-process regressions for `foreman mcp-stdio` (#594): responses must
// not queue behind a pending approval, and a client that disconnects while
// a call waits on a human must still leave an audit row (the call used to
// vanish: no response, no `requests` row, a dangling pending approval).

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

function frame(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
const SECRET_READ = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'read_file', arguments: { path: '/project/.env' } },
}

describe('foreman mcp-stdio lifecycle', () => {
  let home: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-mcp-life-'))
    env = { ...process.env, FOREMAN_HOME: home, FOREMAN_NO_UPDATE_CHECK: '1' }
    spawnSync('node', [FM_BIN, 'init'], { env, encoding: 'utf-8' })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('answers later messages while an earlier call waits for approval', async () => {
    const child = spawn('node', [FM_BIN, 'mcp-stdio', '--source', 'tester'], { env })
    const seen: number[] = []
    let buf = ''
    const gotList = new Promise<void>((resolveList, reject) => {
      const timer = setTimeout(() => reject(new Error(`no tools/list reply; saw ${seen}`)), 8_000)
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const id = (JSON.parse(line) as { id: number }).id
          seen.push(id)
          if (id === 3) {
            clearTimeout(timer)
            resolveList()
          }
        }
      })
    })
    child.stdin.write(frame(INIT))
    child.stdin.write(frame(SECRET_READ) + frame({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))
    await gotList
    // The secret read is still waiting on a human; the list reply got through.
    expect(seen).not.toContain(2)
    child.stdin.end()
    await new Promise((r) => child.on('exit', r))
  }, 20_000)

  it('audits a pending call when the client disconnects, then exits cleanly', async () => {
    const child = spawn('node', [FM_BIN, 'mcp-stdio', '--source', 'tester'], { env })
    child.stdin.write(frame(INIT) + frame(SECRET_READ))
    // Let the approval row land, then drop the connection.
    await new Promise((r) => setTimeout(r, 1_500))
    child.stdin.end()
    const code = await new Promise<number | null>((r) => child.on('exit', r))
    expect(code).toBe(0)
    const log = spawnSync('node', [FM_BIN, 'log', 'tail', '--json'], { env, encoding: 'utf-8' })
    expect(log.stdout).toContain('read_file')
    expect(log.stdout).toContain('denied')
    // Told apart from a real timeout in the audit trail.
    expect(log.stdout).toContain('approval-cancelled')
  }, 20_000)
})
