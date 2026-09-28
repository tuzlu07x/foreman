import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// `foreman service install | status | uninstall`, run as the built CLI on
// this machine's platform, against a temp HOME with fake `launchctl` /
// `systemctl` first on PATH (they record their argv). The real LaunchAgents
// directory and systemd are never touched.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')
const manager = process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd' : null

const FAKE = `#!/bin/sh
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$FAKE_LOG"
case "$(basename "$0") $1" in
  "launchctl print") [ -f "$FAKE_RUNNING" ] && printf '\\tstate = running\\n\\tpid = 4242\\n' && exit 0; exit 113 ;;
esac
case "$*" in
  "--user show foreman-daemon.service"*)
    if [ -f "$FAKE_RUNNING" ]; then printf 'ActiveState=active\\nSubState=running\\nMainPID=4242\\n'
    else printf 'ActiveState=inactive\\nSubState=dead\\nMainPID=0\\n'; fi ;;
esac
exit 0
`

describe.skipIf(manager === null)('foreman service (CLI)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  let log: string
  let running: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fm-svc-cli-'))
    const bin = join(home, 'fakebin')
    mkdirSync(bin)
    for (const name of ['launchctl', 'systemctl']) writeFileSync(join(bin, name), FAKE, { mode: 0o755 })
    log = join(home, 'calls.log')
    running = join(home, 'running')
    env = {
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      HOME: home,
      FOREMAN_HOME: join(home, 'fm'),
      FOREMAN_NO_UPDATE_CHECK: '1',
      FAKE_LOG: log,
      FAKE_RUNNING: running,
    }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const run = (...args: string[]) => spawnSync(process.execPath, [FM_BIN, ...args], { env, encoding: 'utf-8', timeout: 30_000 })
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, 'utf-8')
          .trimEnd()
          .split('\n')
          .map((l) => l.split('\t'))
      : []
  const file =
    manager === 'launchd'
      ? () => join(home, 'Library', 'LaunchAgents', 'dev.foreman.daemon.plist')
      : () => join(home, '.config', 'systemd', 'user', 'foreman-daemon.service')

  it('refuses to install before foreman init', () => {
    const r = run('service', 'install')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/not initialised/)
    expect(existsSync(file())).toBe(false)
    expect(calls()).toEqual([])
  })

  it('installs, reports and uninstalls the service for this node and CLI', () => {
    expect(run('init').status).toBe(0)
    let st = run('service', 'status')
    expect(st.status).toBe(0)
    expect(st.stdout).toMatch(/installed\s+no/)

    const r = run('service', 'install')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/installed the Foreman daemon service/)
    const node = realpathSync(process.execPath)
    const cli = realpathSync(FM_BIN)
    expect(r.stdout).toContain(`runs     ${node} ${cli} daemon --service`)

    const text = readFileSync(file(), 'utf-8')
    expect(statSync(file()).mode & 0o777).toBe(0o644)
    if (manager === 'launchd') {
      expect(text).toContain(`<string>${node}</string>`)
      expect(text).toContain(`<string>${cli}</string>`)
      expect(text).toMatch(new RegExp(`<key>FOREMAN_HOME</key>\\s*<string>${join(home, 'fm')}</string>`))
      const uid = String(process.getuid!())
      expect(calls()).toEqual([
        ['launchctl', 'bootout', `gui/${uid}/dev.foreman.daemon`],
        ['launchctl', 'bootstrap', `gui/${uid}`, file()],
      ])
      expect(r.stdout).toContain(join(home, 'fm', 'daemon.log'))
    } else {
      expect(text).toContain(`ExecStart="${node}" "${cli}" "daemon" "--service"`)
      expect(text).toContain(`Environment="FOREMAN_HOME=${join(home, 'fm')}"`)
      expect(calls()).toEqual([
        ['systemctl', '--user', 'show-environment'],
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', 'foreman-daemon.service'],
      ])
      expect(r.stdout).toContain('journalctl --user -u foreman-daemon.service')
    }

    st = run('service', 'status')
    expect(st.status).toBe(0)
    expect(st.stdout).toContain(`installed  yes — ${file()}`)
    expect(st.stdout).toMatch(/running\s+no/)
    expect(st.stdout).toContain(`runs       ${node} ${cli} daemon --service`)
    expect(st.stdout).toContain(`home       ${join(home, 'fm')}`)
    writeFileSync(running, '')
    st = run('service', 'status')
    expect(st.stdout).toMatch(/running\s+yes \(pid 4242\)/)

    const u = run('service', 'uninstall')
    expect(u.status).toBe(0)
    expect(u.stdout).toMatch(/stopped and removed/)
    expect(existsSync(file())).toBe(false)
    expect(run('service', 'uninstall').stdout).toMatch(/Not installed/)
  }, 60_000)
})

describe.skipIf(process.platform !== 'win32')('foreman service on native Windows', () => {
  it('says it is not supported', () => {
    const r = spawnSync(process.execPath, [FM_BIN, 'service', 'status'], { encoding: 'utf-8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/isn't supported here: native Windows/)
  })
})
