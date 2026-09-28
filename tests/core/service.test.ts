import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installService,
  parseServiceFile,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceEnvironment,
  serviceFilePath,
  serviceManagerFor,
  serviceRunning,
  systemRunner,
  uninstallService,
  writeServiceFile,
  type ServiceContext,
  type ServiceManager,
  type ServiceSpec,
} from '../../src/core/service.js'

// `foreman service` hands `foreman daemon --service` to launchd or systemd.
// Nothing here touches the real ~/Library/LaunchAgents or systemd: every
// test uses a temp home, and `launchctl` / `systemctl` are fake scripts
// (first on PATH) that record their argv.

const spec = (over: Partial<ServiceSpec> = {}): ServiceSpec => ({
  program: ['/opt/My Node/bin/node', '/Users/a b/lib/foreman/dist/cli/index.js', 'daemon', '--service'],
  env: [['PATH', '/usr/bin:/bin']],
  workingDirectory: '/Users/a b',
  logPath: '/Users/a b/Library/Application Support/foreman/daemon.log',
  ...over,
})

describe('service: which manager', () => {
  it('is launchd on macOS, systemd on Linux (and WSL2), none on Windows', () => {
    expect(serviceManagerFor('darwin')).toBe('launchd')
    expect(serviceManagerFor('linux')).toBe('systemd')
    expect(serviceManagerFor('win32')).toBeNull()
    expect(serviceManagerFor('freebsd')).toBeNull()
  })

  it('writes to the per-user locations', () => {
    expect(serviceFilePath('launchd', '/h')).toBe('/h/Library/LaunchAgents/dev.foreman.daemon.plist')
    expect(serviceFilePath('systemd', '/h')).toBe('/h/.config/systemd/user/foreman-daemon.service')
  })
})

describe('service: launchd plist', () => {
  it('runs absolute paths with spaces as separate arguments, restarts on a crash, logs to the state dir', () => {
    const text = renderLaunchdPlist(spec())
    expect(text).toContain('<string>dev.foreman.daemon</string>')
    expect(text).toContain('<string>/opt/My Node/bin/node</string>')
    expect(text).toContain('<string>/Users/a b/lib/foreman/dist/cli/index.js</string>')
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(text).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/Users\/a b\/Library\/Application Support\/foreman\/daemon.log<\/string>/)
    expect(text).not.toContain('FOREMAN_HOME')
    expect(parseServiceFile('launchd', text)).toEqual({
      program: spec().program,
      env: { PATH: '/usr/bin:/bin' },
      logPath: spec().logPath,
    })
  })

  it('passes FOREMAN_HOME when it is set, and escapes XML', () => {
    const text = renderLaunchdPlist(
      spec({
        program: ['/n/node', '/x/<&"\'>/index.js', 'daemon', '--service'],
        env: [['PATH', '/bin'], ['FOREMAN_HOME', '/tmp/fm home & co']],
      }),
    )
    expect(text).toContain('<key>FOREMAN_HOME</key>')
    expect(text).toContain('<string>/tmp/fm home &amp; co</string>')
    expect(text).toContain('/x/&lt;&amp;&quot;&apos;&gt;/index.js')
    expect(parseServiceFile('launchd', text)?.program[1]).toBe('/x/<&"\'>/index.js')
    expect(parseServiceFile('launchd', text)?.env.FOREMAN_HOME).toBe('/tmp/fm home & co')
  })

  it('refuses control characters, bad names and relative programs', () => {
    expect(() => renderLaunchdPlist(spec({ program: ['/n/node\n<key>x</key>', 'daemon'] }))).toThrow(/control character/)
    expect(() => renderLaunchdPlist(spec({ env: [['PA TH', '/bin']] }))).toThrow(/invalid environment variable/)
    expect(() => renderLaunchdPlist(spec({ program: ['node', 'daemon'] }))).toThrow(/absolute path/)
  })
})

describe('service: systemd unit', () => {
  it('quotes every argument, so paths with spaces stay one word', () => {
    const text = renderSystemdUnit(spec({ logPath: null }))
    expect(text).toContain(
      'ExecStart="/opt/My Node/bin/node" "/Users/a b/lib/foreman/dist/cli/index.js" "daemon" "--service"',
    )
    expect(text).toContain('Environment="PATH=/usr/bin:/bin"')
    expect(text).toContain('Restart=on-failure')
    expect(text).toContain('WantedBy=default.target')
    expect(text).toContain('WorkingDirectory=%h')
    expect(text).not.toContain('FOREMAN_HOME')
    expect(parseServiceFile('systemd', text)).toEqual({ program: spec().program, env: { PATH: '/usr/bin:/bin' }, logPath: null })
  })

  it('passes FOREMAN_HOME when set, escaping quotes, backslashes, % and $', () => {
    const text = renderSystemdUnit(
      spec({
        program: ['/n/node', '/x/50%"$HOME\\/index.js', 'daemon', '--service'],
        env: [['PATH', '/bin'], ['FOREMAN_HOME', '/tmp/a "b" 100%$x']],
        logPath: null,
      }),
    )
    expect(text).toContain('ExecStart="/n/node" "/x/50%%\\"$$HOME\\\\/index.js"')
    // Environment= doesn't expand $, so it stays single there.
    expect(text).toContain('Environment="FOREMAN_HOME=/tmp/a \\"b\\" 100%%$x"')
    const parsed = parseServiceFile('systemd', text)
    expect(parsed?.program[1]).toBe('/x/50%"$HOME\\/index.js')
    expect(parsed?.env.FOREMAN_HOME).toBe('/tmp/a "b" 100%$x')
  })

  it('refuses a newline that would add a directive', () => {
    expect(() =>
      renderSystemdUnit(spec({ env: [['FOREMAN_HOME', '/x\nExecStartPre=/bin/evil']], logPath: null })),
    ).toThrow(/control character/)
  })
})

describe('service: environment', () => {
  it('keeps absolute PATH entries once, FOREMAN_HOME when set, and never proxy settings', () => {
    const env = {
      PATH: ['/usr/bin', '', '.', 'rel/bin', '/usr/bin', '/opt/bin'].join(delimiter),
      HTTPS_PROXY: 'http://user:secret@proxy:8080',
      FOREMAN_HOME: '/tmp/fm',
      XDG_STATE_HOME: '/tmp/state',
    }
    expect(serviceEnvironment(env, 'launchd')).toEqual([
      ['PATH', ['/usr/bin', '/opt/bin'].join(delimiter)],
      ['FOREMAN_HOME', '/tmp/fm'],
    ])
    expect(serviceEnvironment(env, 'systemd')).toEqual([
      ['PATH', ['/usr/bin', '/opt/bin'].join(delimiter)],
      ['FOREMAN_HOME', '/tmp/fm'],
      ['XDG_STATE_HOME', '/tmp/state'],
    ])
    expect(serviceEnvironment({ PATH: '/bin' }, 'launchd')).toEqual([['PATH', '/bin']])
  })
})

describe('service: writing the file', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fm-svc-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('writes 0644 in the home directory, creating the directory', () => {
    const file = serviceFilePath('systemd', home)
    expect(writeServiceFile(file, 'x\n', home)).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe('x\n')
    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(writeServiceFile(file, 'y\n', home)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('y\n')
  })

  it('refuses a symlink at the target, and leaves what it points to alone', () => {
    const file = serviceFilePath('launchd', home)
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    const victim = join(home, 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, file)
    expect(() => writeServiceFile(file, 'x', home)).toThrow(/symlink/)
    expect(readFileSync(victim, 'utf-8')).toBe('keep')
  })

  it('refuses a directory that resolves outside the home directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'fm-svc-out-'))
    try {
      mkdirSync(join(home, 'Library'), { recursive: true })
      symlinkSync(outside, join(home, 'Library', 'LaunchAgents'))
      expect(() => writeServiceFile(serviceFilePath('launchd', home), 'x', home)).toThrow(/outside your home/)
      expect(existsSync(join(outside, 'dev.foreman.daemon.plist'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a directory other users can write to', () => {
    const dir = join(home, '.config', 'systemd', 'user')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o777)
    expect(() => writeServiceFile(serviceFilePath('systemd', home), 'x', home)).toThrow(/writable by other users/)
  })
})

// Fake launchctl / systemctl: record argv (tab-separated), fail on demand.
const FAKE = `#!/bin/sh
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$FAKE_LOG"
case "$*" in
  $FAKE_FAIL) echo "fake failure: $*" >&2; exit 1 ;;
esac
case "$(basename "$0") $1" in
  "launchctl print") printf '\\tstate = running\\n\\tpid = 4242\\n' ;;
esac
case "$*" in
  "--user show foreman-daemon.service"*) printf 'ActiveState=active\\nSubState=running\\nMainPID=4242\\n' ;;
esac
exit 0
`

describe('service: install, status, uninstall (fake launchctl / systemctl)', () => {
  let home: string
  let bin: string
  let log: string
  let fail: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fm-svc-run-'))
    bin = join(home, 'fakebin')
    log = join(home, 'calls.log')
    mkdirSync(bin)
    for (const name of ['launchctl', 'systemctl']) {
      writeFileSync(join(bin, name), FAKE, { mode: 0o755 })
    }
    mkdirSync(join(home, 'state'))
    fail = '__never__'
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const ctx = (manager: ServiceManager): ServiceContext => ({
    manager,
    home,
    stateDir: join(home, 'state'),
    uid: 501,
    run: (cmd, args) =>
      systemRunner({ PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, FAKE_LOG: log, FAKE_FAIL: fail })(cmd, args),
  })
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, 'utf-8')
          .trimEnd()
          .split('\n')
          .map((l) => l.split('\t'))
      : []
  const program = [process.execPath, join(process.cwd(), 'package.json'), 'daemon', '--service']
  let env: Array<[string, string]>
  beforeEach(() => {
    env = [['PATH', '/usr/bin'], ['FOREMAN_HOME', join(home, 'fm')]]
  })

  it('launchd: writes the plist, bootstraps it into gui/<uid>, reports and removes it', () => {
    const c = ctx('launchd')
    const r = installService(c, program, env)
    const file = join(home, 'Library', 'LaunchAgents', 'dev.foreman.daemon.plist')
    expect(r).toMatchObject({ file, replaced: false, loadedWith: 'launchctl bootstrap' })
    expect(statSync(file).mode & 0o777).toBe(0o644)
    const text = readFileSync(file, 'utf-8')
    expect(parseServiceFile('launchd', text)).toEqual({
      program,
      env: { PATH: '/usr/bin', FOREMAN_HOME: join(home, 'fm') },
      logPath: join(home, 'state', 'daemon.log'),
    })
    // The log exists before launchd opens it, owner-only.
    expect(statSync(join(home, 'state', 'daemon.log')).mode & 0o777).toBe(0o600)
    expect(calls()).toEqual([
      ['launchctl', 'bootout', 'gui/501/dev.foreman.daemon'],
      ['launchctl', 'bootstrap', 'gui/501', file],
    ])

    expect(serviceRunning(c)).toEqual({ running: true, pid: 4242, detail: 'running' })

    expect(installService(c, program, env).replaced).toBe(true)

    rmSync(log)
    expect(uninstallService(c)).toEqual({ file, removed: true, warning: null })
    expect(existsSync(file)).toBe(false)
    expect(calls()).toEqual([['launchctl', 'bootout', 'gui/501/dev.foreman.daemon']])
    expect(uninstallService(c).removed).toBe(false)
  })

  it('launchd: falls back to launchctl load -w when bootstrap fails', () => {
    fail = 'bootstrap*'
    const r = installService(ctx('launchd'), program, env)
    expect(r.loadedWith).toBe('launchctl load -w')
    // bootout succeeded, so bootstrap is retried a few times first (a
    // service just booted out can take a moment to go away).
    expect(calls().map((c) => c[1])).toEqual(['bootout', ...Array(6).fill('bootstrap'), 'load'])
    expect(calls().at(-1)).toEqual(['launchctl', 'load', '-w', r.file])
  })

  it('launchd: says so when nothing could load it', () => {
    fail = '*'
    expect(() => installService(ctx('launchd'), program, env)).toThrow(/launchctl couldn't load .*fake failure/)
  })

  it('systemd: writes the unit, reloads, enables and starts it; restarts on a reinstall', () => {
    const c = ctx('systemd')
    const r = installService(c, program, env)
    const file = join(home, '.config', 'systemd', 'user', 'foreman-daemon.service')
    expect(r).toMatchObject({ file, replaced: false, logPath: null })
    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(parseServiceFile('systemd', readFileSync(file, 'utf-8'))).toEqual({
      program,
      env: { PATH: '/usr/bin', FOREMAN_HOME: join(home, 'fm') },
      logPath: null,
    })
    expect(calls()).toEqual([
      ['systemctl', '--user', 'show-environment'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'foreman-daemon.service'],
    ])
    expect(serviceRunning(c)).toEqual({ running: true, pid: 4242, detail: 'running' })

    rmSync(log)
    expect(installService(c, program, env).replaced).toBe(true)
    expect(calls().at(-1)).toEqual(['systemctl', '--user', 'restart', 'foreman-daemon.service'])

    rmSync(log)
    expect(uninstallService(c)).toEqual({ file, removed: true, warning: null })
    expect(existsSync(file)).toBe(false)
    expect(calls()).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'foreman-daemon.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ])
  })

  it('systemd: without a user manager (WSL without systemd) writes nothing and says what to do', () => {
    fail = '--user show-environment'
    expect(() => installService(ctx('systemd'), program, env)).toThrow(
      /systemd --user isn't available here.*WSL.*Run `foreman daemon` yourself/,
    )
    expect(existsSync(join(home, '.config', 'systemd'))).toBe(false)
  })

  it('systemd: no systemctl at all is the same', () => {
    const c: ServiceContext = { ...ctx('systemd'), run: systemRunner({ PATH: join(home, 'empty') }) }
    expect(() => installService(c, program, env)).toThrow(/systemd --user isn't available here \(no systemctl\)/)
  })

  it('refuses to install a program that does not exist', () => {
    expect(() => installService(ctx('launchd'), ['/nonexistent/node', '/x.js', 'daemon', '--service'], env)).toThrow(
      /\/nonexistent\/node doesn't exist/,
    )
    expect(calls()).toEqual([])
  })

  it('uninstall refuses a symlink it did not write, before stopping anything', () => {
    const file = serviceFilePath('launchd', home)
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(join(home, 'elsewhere'), 'x')
    symlinkSync(join(home, 'elsewhere'), file)
    expect(() => uninstallService(ctx('launchd'))).toThrow(/symlink/)
    expect(calls()).toEqual([])
  })
})
