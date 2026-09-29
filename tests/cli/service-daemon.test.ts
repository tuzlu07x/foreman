import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { attachedGatewayState, startForeman } from '../../src/cli/start.js'
import { bus } from '../../src/core/event-bus.js'
import { ForemanAlreadyRunningError } from '../../src/core/foreman-pidfile.js'
import { probeGateway } from '../../src/core/gateway.js'
import { closeDb, getDb } from '../../src/db/client.js'

// The background service runs `foreman daemon --service`: the headless
// gateway (the daemon, approvals to chat, schedulers, the control drain).
// One gateway per home:
//   - a service that finds a plain `foreman daemon` listening waits for the
//     socket, and takes it over when that one stops (instead of exiting and
//     being restarted in a loop by launchd / systemd);
//   - `foreman start` with the service running attaches to it: TUI only,
//     approvals are DB-backed, so they show up and are decided there;
//   - a service started while `foreman start` runs waits, and takes over
//     the whole gateway when `foreman start` quits;
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

  it('foreman start attaches to the running service: TUI only, and a decision made there reaches the agent', async () => {
    runInit()
    const service = daemon('--service')
    await until(() => service.stderr().includes('daemon: listening on'))

    // The service holds the home: a full `foreman start` is refused, and
    // the CLI attaches instead.
    expect(() => startForeman({ withTui: false })).toThrow(ForemanAlreadyRunningError)
    closeDb()
    const gateway = attachedGatewayState(home)
    expect(gateway).toEqual({ pid: service.child.pid })

    const requested: string[] = []
    const off = bus.on('approval:requested', (e) => {
      requested.push(e.requestId)
    })
    const started = startForeman({ withTui: false, attach: gateway! })
    expect(started.mode).toBe('attached')
    try {
      // A risky hook call is decided by the service (it asks a person);
      // the approval shows up in the attached TUI via the database.
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
      const db = new Database(join(home, 'foreman.db'), { readonly: true })
      const row = db
        .prepare('SELECT decision, resolved_by, resolved_via FROM pending_approvals WHERE request_id = ?')
        .get(requested[0])
      db.close()
      expect(row).toEqual({ decision: 'allowed', resolved_by: 'user', resolved_via: 'tui' })
    } finally {
      off()
      await started.shutdown()
    }
    // Quitting the attached TUI leaves the gateway running, and its pidfile.
    expect(service.child.exitCode).toBeNull()
    expect(existsSync(join(home, 'foreman.sock'))).toBe(true)
    expect(probeGateway(home)).toMatchObject({ state: 'running', mode: 'headless', pid: service.child.pid })
  }, 90_000)

  it('stopping the service while a call waits for approval blocks the call', async () => {
    runInit()
    const service = daemon('--service')
    await until(() => service.stderr().includes('daemon: listening on'))
    let stderr = ''
    const hook = spawn(process.execPath, [HOOK_BIN, 'claude-code', '--timeout-ms', '60000'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: '' },
    })
    children.push(hook)
    hook.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    hook.stdin!.end(JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } }))
    const pending = (): number => {
      const db = new Database(join(home, 'foreman.db'), { readonly: true })
      try {
        return (db.prepare("SELECT count(*) AS n FROM pending_approvals WHERE status = 'pending'").get() as { n: number }).n
      } finally {
        db.close()
      }
    }
    await until(() => pending() === 1, 30_000)

    service.child.kill('SIGTERM')
    expect(await exitOf(hook)).toBe(2)
    expect(stderr).toMatch(/shutting down/)
    expect(await exitOf(service.child)).toBe(0)
  }, 90_000)

  it('waits while foreman start runs, and takes over the whole gateway when it quits', async () => {
    runInit()
    const started = startForeman({ withTui: false })
    let service: ReturnType<typeof daemon>
    try {
      await until(() => existsSync(join(home, 'foreman.sock')))
      service = daemon('--service')
      await until(() => service.stderr().includes('waiting to take over'))
      expect(service.stderr()).toMatch(/foreman start is running on this home/)
      expect(probeGateway(home)).toMatchObject({ state: 'running', mode: 'tui', pid: process.pid })
    } finally {
      await started.shutdown()
    }
    closeDb()
    await until(() => service!.stderr().includes('daemon: listening on'), 30_000)
    expect(probeGateway(home)).toMatchObject({ state: 'running', mode: 'headless', pid: service!.child.pid })

    service!.child.kill('SIGTERM')
    expect(await exitOf(service!.child)).toBe(0)
    expect(existsSync(join(home, 'foreman.pid'))).toBe(false)
    expect(existsSync(join(home, 'foreman.sock'))).toBe(false)
  }, 90_000)
})
