import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// install.sh, run with stand-ins for foreman, npm and nvm: nothing is
// installed, nothing reaches the network, and no real config is touched.

const INSTALL_SH = resolve(dirname(fileURLToPath(import.meta.url)), '../../install.sh')

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  let root: string
  let calls: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fm-install-'))
    calls = join(root, 'calls.log')
    writeFileSync(calls, '')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const stub = (dir: string, name: string, body: string): void => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`)
    chmodSync(file, 0o755)
  }

  /** A foreman installed under an nvm Node the shell doesn't use. */
  const nvmInstall = (agents: string[]): string => {
    const bin = join(root, 'home', '.nvm', 'versions', 'node', 'v22.23.3', 'bin')
    const list = JSON.stringify(agents.map((id) => ({ id })))
    stub(bin, 'foreman', `case "$1 $2" in "agent list") echo '${list}' ;; esac\nexit 0`)
    stub(bin, 'npm', 'exit 0')
    return bin
  }

  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [INSTALL_SH, ...args], {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: join(root, 'home'),
        NVM_DIR: join(root, 'home', '.nvm'),
        FOREMAN_HOME: join(root, 'data'),
        ...env,
      },
      encoding: 'utf-8',
      // No terminal: every question takes its default.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  it('--uninstall finds foreman under an nvm Node, takes it out of every agent, then removes the package', () => {
    nvmInstall(['claude-code', 'codex'])
    mkdirSync(join(root, 'data'))
    const r = run(['--uninstall'])
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(calls, 'utf-8').trim().split('\n')).toEqual([
      'foreman service uninstall',
      'foreman agent list --json',
      'foreman agent remove claude-code --yes',
      'foreman agent remove codex --yes',
      'npm uninstall -g foreman-agent',
    ])
    expect(r.stderr).toContain("claude-code: removed, with Foreman's MCP entry (and Claude Code hook) in its config")
    // Without a terminal the data stays (the default answer is no).
    expect(existsSync(join(root, 'data'))).toBe(true)
    expect(r.stderr).toContain('left in place')
  })

  it('--uninstall --purge deletes Foreman data without asking', () => {
    nvmInstall([])
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'identity.key'), 'x')
    const r = run(['--uninstall', '--purge'])
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(join(root, 'data'))).toBe(false)
    expect(r.stderr).toContain('no agents registered')
  })

  it('says so when there is no foreman to find, and rejects --purge alone', () => {
    const r = run(['--uninstall'])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain("foreman isn't installed here")
    const purge = run(['--purge'])
    expect(purge.status).toBe(1)
    expect(purge.stderr).toContain('--purge goes with --uninstall')
  })

  /** check_default_node with a stand-in nvm whose default is `major`. */
  const checkDefault = (major: string, env: Record<string, string>) =>
    spawnSync(
      'bash',
      [
        '-c',
        `FOREMAN_INSTALL_SOURCE_ONLY=1 . '${INSTALL_SH}'
         nvm() { echo "nvm $*" >> '${calls}'; [ "$1" = version ] && echo "v${major}.1.0"; return 0; }
         SWITCHED_NODE=1
         check_default_node`,
      ],
      { env: { PATH: '/usr/bin:/bin', HOME: root, ...env }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    )

  it('warns when new terminals would start with an nvm default foreman is not installed for, and can switch it', () => {
    const left = checkDefault('20', { FOREMAN_NVM_DEFAULT: '0' })
    expect(left.stderr).toContain("Your nvm default is Node 20, so new terminals won't find 'foreman'")
    expect(left.stderr).toContain('nvm alias default 22')
    expect(readFileSync(calls, 'utf-8')).not.toContain('nvm alias')

    const switched = checkDefault('20', { FOREMAN_NVM_DEFAULT: '1' })
    expect(switched.stderr).toContain('Node 22 is now your nvm default')
    expect(readFileSync(calls, 'utf-8')).toContain('nvm alias default 22')
  })

  it('stays quiet when the default Node already works, and asks nothing without a terminal', () => {
    expect(checkDefault('22', {}).stderr).toBe('')
    expect(checkDefault('24', {}).stderr).toBe('')
    // No terminal, no FOREMAN_NVM_DEFAULT: nothing changes unasked.
    const r = checkDefault('20', {})
    expect(r.stderr).toContain('Left your default alone')
    expect(readFileSync(calls, 'utf-8')).not.toContain('nvm alias')
  })
})
