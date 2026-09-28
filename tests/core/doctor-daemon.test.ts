import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDaemon } from '../../src/core/doctor.js'

// `foreman doctor` says whether agents can use the daemon `foreman start`
// hosts, and why not when they can't. It never connects.
describe('doctor: daemon', () => {
  let home: string
  let saved: string | undefined
  let server: Server | null = null

  beforeEach(() => {
    saved = process.env.FOREMAN_HOME
    home = mkdtempSync(join(tmpdir(), 'fm-dd-'))
    chmodSync(home, 0o700)
    process.env.FOREMAN_HOME = home
  })
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = null
    if (saved === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = saved
    rmSync(home, { recursive: true, force: true })
  })

  const listen = async (mode: number): Promise<void> => {
    server = createServer()
    await new Promise<void>((r) => server!.listen(join(home, 'foreman.sock'), () => r()))
    chmodSync(join(home, 'foreman.sock'), mode)
    writeFileSync(join(home, 'foreman.sock.token'), 'a'.repeat(43), { mode: 0o600 })
  }

  it('is not used on Windows, or when turned off', () => {
    expect(checkDaemon({}, 'win32')).toMatchObject({ status: 'ok', message: expect.stringContaining('not used') })
    expect(checkDaemon({ FOREMAN_NO_DAEMON: '1' }, 'linux', home)).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('turned off'),
    })
  })

  it('says it is not running when foreman start is not up', () => {
    expect(checkDaemon({}, 'linux', home)).toMatchObject({ status: 'ok', message: expect.stringContaining('not running') })
  })

  it('warns when the background service is installed but the daemon is not running', () => {
    for (const [platform, file] of [
      ['linux', join(home, '.config', 'systemd', 'user', 'foreman-daemon.service')],
      ['darwin', join(home, 'Library', 'LaunchAgents', 'dev.foreman.daemon.plist')],
    ] as const) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '# test\n')
      const r = checkDaemon({}, platform, home)
      expect(r.status).toBe('warn')
      expect(r.message).toContain(`not running, though the background service is installed (${file})`)
      expect(r.remediation).toContain('foreman service status')
    }
  })

  it('does not mention the service once the daemon listens', async () => {
    const file = join(home, 'Library', 'LaunchAgents', 'dev.foreman.daemon.plist')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '# test\n')
    await listen(0o600)
    expect(checkDaemon({}, 'darwin', home)).toMatchObject({ status: 'ok', message: expect.stringContaining('listening at') })
  })

  it('reports a socket agents can use', async () => {
    await listen(0o600)
    expect(checkDaemon({}, process.platform, home)).toMatchObject({
      status: 'ok',
      message: `listening at ${join(home, 'foreman.sock')}`,
    })
  })

  it('warns about a socket agents will not trust', async () => {
    await listen(0o666)
    const r = checkDaemon({}, process.platform, home)
    expect(r.status).toBe('warn')
    expect(r.message).toMatch(/not trusted: .*open to other users/)
    expect(r.remediation).toContain('foreman.sock.token')
  })

  it('warns when the socket path is too long to start at all', () => {
    process.env.FOREMAN_HOME = join(home, 'x'.repeat(100))
    const r = checkDaemon({}, 'linux', home)
    expect(r.status).toBe('warn')
    expect(r.message).toMatch(/socket path is \d+ characters \(the limit is 100\)/)
    expect(r.remediation).toContain('shorter FOREMAN_HOME')
  })
})
