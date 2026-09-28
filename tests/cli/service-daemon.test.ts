import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { startForeman } from '../../src/cli/start.js'
import { bus } from '../../src/core/event-bus.js'
import { InboxService } from '../../src/core/inbox.js'
import { closeDb, getDb } from '../../src/db/client.js'

// The background service runs `foreman daemon --service`. It has to live
// alongside `foreman start`, which hosts a daemon of its own:
//   - a service daemon that finds another daemon listening waits, and takes
//     over when that one stops (instead of exiting and being restarted in a
//     loop by launchd / systemd);
//   - `foreman start` with a service daemon already listening starts fine,
//     leaves agents on that daemon, and still shows their approvals (they
//     are DB-backed, so the TUI's ApprovalBridge picks them up);
//   - a service that can't start for a reason a restart won't fix exits 0.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FM_BIN = join(ROOT, 'dist/cli/index.js')
const HOOK_BIN = join(ROOT, 'dist/cli/hook.js')

const until = async (check: () => boolean, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(process.platform === 'win32')('foreman daemon --service', () => {
  let home: string
  let saved: NodeJS.ProcessEnv
  const children: ChildProcess[] = []

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fm-svcd-'))
    saved = { ...process.env }
    process.env.FOREMAN_HOME = home
    process.env.HOME = home
    process.env.FOREMAN_NO_UPDATE_CHECK = '1'
    process.env.FOREMAN_NO_AGENT_UPDATE_CHECK = '1'
    delete process.env.FOREMAN_NO_DAEMON
  })
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.on('exit', r))
        child.kill('SIGKILL')
        await exited
      }
    }
    closeDb()
    process.env = saved
    rmSync(home, { recursive: true, force: true })
  })

  const daemon = (...args: string[]): { child: ChildProcess; stderr: () => string } => {
    let err = ''
    const child = spawn(process.execPath, [FM_BIN, 'daemon', ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr!.on('data', (d: Buffer) => {
      err += d.toString()
    })
    children.push(child)
    return { child, stderr: () => err }
  }
  const exitOf = (child: ChildProcess): Promise<number | null> =>
    child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((r) => child.on('exit', (code) => r(code)))

  it('exits 0 (no restart loop) when Foreman is not initialised', () => {
    const r = spawnSync(process.execPath, [FM_BIN, 'daemon', '--service'], {
      env: { ...process.env },
      encoding: 'utf-8',
      timeout: 20_000,
    })
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/not initialised/)
    expect(r.stderr).toMatch(/not restarting until this is fixed/)
    // Without --service it is still an error.
    const plain = spawnSync(process.execPath, [FM_BIN, 'daemon'], { env: { ...process.env }, encoding: 'utf-8', timeout: 20_000 })
    expect(plain.status).toBe(1)
  })

  it('waits while another daemon listens, and takes over when it stops', async () => {
    runInit()
    const first = daemon()
    await until(() => first.stderr().includes('daemon: listening on'))
    const service = daemon('--service')
    await until(() => service.stderr().includes('waiting to take over'))
    expect(service.child.exitCode).toBeNull()

    first.child.kill('SIGTERM')
    expect(await exitOf(first.child)).toBe(0)
    await until(() => service.stderr().includes('daemon: listening on'))
    expect(existsSync(join(home, 'foreman.sock'))).toBe(true)

    service.child.kill('SIGTERM')
    expect(await exitOf(service.child)).toBe(0)
    expect(existsSync(join(home, 'foreman.sock'))).toBe(false)
  }, 60_000)

  it('a waiting service stops cleanly on SIGTERM', async () => {
    runInit()
    const first = daemon()
    await until(() => first.stderr().includes('daemon: listening on'))
    const service = daemon('--service')
    await until(() => service.stderr().includes('waiting to take over'))
    service.child.kill('SIGTERM')
    expect(await exitOf(service.child)).toBe(0)
    // The daemon that was listening is untouched.
    expect(first.child.exitCode).toBeNull()
    expect(existsSync(join(home, 'foreman.sock'))).toBe(true)
  }, 60_000)

  it('foreman start uses a daemon that is already running, and its approvals reach the TUI', async () => {
    runInit()
    const service = daemon('--service')
    await until(() => service.stderr().includes('daemon: listening on'))

    const requested: string[] = []
    const off = bus.on('approval:requested', (e) => {
      requested.push(e.requestId)
    })
    const started = startForeman({ withTui: false })
    try {
      const inbox = new InboxService(getDb())
      await until(() => inbox.list({ limit: 50 }).some((i) => i.title.includes('already running')))
      expect(inbox.list({ limit: 50 }).some((i) => i.title.includes('Agents run without the Foreman daemon'))).toBe(false)

      // A risky hook call is decided by the service daemon (it asks a
      // person), and the approval shows up on start's bus via the DB.
      const hook = new Promise<{ exit: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [HOOK_BIN, 'claude-code', '--timeout-ms', '60000'], {
          env: { ...process.env, CLAUDE_CONFIG_DIR: '' },
        })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        child.on('exit', (exit) => done({ exit, stderr }))
        child.stdin.end(JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } }))
      })
      await until(() => requested.length > 0, 30_000)
      bus.emit('approval:resolved', {
        requestId: requested[0]!,
        decision: 'allowed',
        resolvedBy: 'user',
        via: 'tui',
      })
      const r = await hook
      expect(r.stderr).not.toMatch(/not using the Foreman daemon/)
      expect(r.exit).toBe(0)
      // start's shutdown leaves the service daemon running.
    } finally {
      off()
      await started.shutdown()
    }
    expect(service.child.exitCode).toBeNull()
    expect(existsSync(join(home, 'foreman.sock'))).toBe(true)
  }, 90_000)
})
