import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// install.sh, run with stand-ins for foreman, npm and nvm: nothing is
// installed, nothing reaches the network, and no real config is touched.
//
// PATH holds only this test's own `node` link and the system tools, never
// the directory of the Node running the tests: on a machine with Foreman
// installed through nvm, that directory holds the real `foreman` and
// `npm`, and `install.sh --uninstall` found and ran them, uninstalling
// the developer's Foreman (real-services test, 2.3.0).

const INSTALL_SH = resolve(dirname(fileURLToPath(import.meta.url)), '../../install.sh')

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  let root: string
  let calls: string
  /** `node` only, for install.sh's own Node checks. */
  let sysBin: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fm-install-'))
    calls = join(root, 'calls.log')
    writeFileSync(calls, '')
    sysBin = join(root, 'sysbin')
    mkdirSync(sysBin)
    symlinkSync(process.execPath, join(sysBin, 'node'))
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

  const safePath = (): string => `${sysBin}:/usr/bin:/bin`

  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [INSTALL_SH, ...args], {
      env: {
        PATH: safePath(),
        HOME: join(root, 'home'),
        NVM_DIR: join(root, 'home', '.nvm'),
        FOREMAN_HOME: join(root, 'data'),
        ...env,
      },
      encoding: 'utf-8',
      // No terminal: every question takes its default.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  it('can only reach its own stand-ins: no real foreman or npm on PATH', () => {
    nvmInstall([])
    const found = spawnSync('bash', ['-c', 'command -v foreman npm || true'], {
      env: { PATH: safePath(), HOME: join(root, 'home') },
      encoding: 'utf-8',
    })
    expect(found.stdout.trim()).toBe('')
    expect(safePath()).not.toContain(dirname(process.execPath))
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
      // Claude Code's hook goes before the package, even for an agent not
      // registered: a hook left behind would block every tool call.
      'foreman agent hook uninstall claude-code',
      'npm uninstall -g foreman-agent',
    ])
    expect(r.stderr).toContain("claude-code: removed, with Foreman's MCP entry (and Claude Code hook) in its config")
    // Without a terminal the data stays (the default answer is no).
    expect(existsSync(join(root, 'data'))).toBe(true)
    expect(r.stderr).toContain('left in place')
  })

  it("--uninstall says how to free Claude Code by hand when its hook can't be removed", () => {
    const bin = join(root, 'home', '.nvm', 'versions', 'node', 'v22.23.3', 'bin')
    stub(bin, 'foreman', `case "$1 $2" in "agent list") echo '[]' ;; "agent hook") exit 1 ;; esac\nexit 0`)
    stub(bin, 'npm', 'exit 0')
    const r = run(['--uninstall'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain("couldn't remove Foreman's hook")
    expect(r.stderr).toContain('hooks.PreToolUse')
    expect(readFileSync(calls, 'utf-8')).toContain('npm uninstall -g foreman-agent')
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
      { env: { PATH: safePath(), HOME: root, ...env }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
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

  /** Runs `script` after sourcing install.sh, with an nvm stand-in. */
  const sourced = (script: string, env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', `FOREMAN_INSTALL_SOURCE_ONLY=1 . '${INSTALL_SH}'\n${script}`], {
      env: { PATH: safePath(), HOME: root, ...env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** A shell whose node is v20, with nvm (a stand-in) installed. */
  const oldNodeWithNvm = (withNode22: boolean): Record<string, string> => {
    const nvmDir = join(root, '.nvm')
    mkdirSync(nvmDir, { recursive: true })
    writeFileSync(join(nvmDir, 'nvm.sh'), `nvm() { echo "nvm $*" >> '${calls}'; return 0; }\n`)
    if (withNode22) stub(join(nvmDir, 'versions', 'node', 'v22.23.3', 'bin'), 'node', 'echo v22.23.3')
    const bin = join(root, 'bin')
    stub(bin, 'node', 'echo v20.11.0')
    return { PATH: `${bin}:${safePath()}`, NVM_DIR: nvmDir }
  }

  it('switches to a Node 22 nvm already has instead of saying it installs one', () => {
    const r = sourced('ensure_node', oldNodeWithNvm(true))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('Node 22 LTS is installed through nvm but not active (this shell has: v20.11.0) — switching to it')
    expect(r.stderr).not.toContain('installing')
    const log = readFileSync(calls, 'utf-8')
    expect(log).toContain('nvm use 22')
    expect(log).not.toContain('nvm install')
  })

  it('says it installs Node 22 through nvm only when nvm has none', () => {
    const r = sourced('ensure_node', oldNodeWithNvm(false))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('Node 22 LTS not detected — installing it via nvm')
    expect(readFileSync(calls, 'utf-8')).toContain('nvm install 22')
  })

  it("tells the caller to run 'nvm use 22' first after switching Node, since their terminal keeps the old one", () => {
    const plain = sourced('next_steps')
    expect(plain.stdout).not.toContain('nvm use')
    const switchedDefault = sourced('SWITCHED_NODE=1 DEFAULT_NODE_OK=1 next_steps')
    expect(switchedDefault.stdout).toContain('0. nvm use 22')
    expect(switchedDefault.stdout).toContain('or open a new terminal')
    const switchedOnly = sourced('SWITCHED_NODE=1 next_steps')
    expect(switchedOnly.stdout).toContain('0. nvm use 22')
    expect(switchedOnly.stdout).toContain('here and in each new terminal')
  })

  it('reads the [Y/n] answer from the terminal: Enter and y proceed, n declines', () => {
    const tty = join(root, 'tty')
    const answer = (typed: string): number => {
      writeFileSync(tty, typed)
      return sourced(`ASK_TTY='${tty}'; ask "Proceed" y`).status ?? -1
    }
    expect(answer('y\n')).toBe(0)
    expect(answer('\n')).toBe(0)
    expect(answer(' Yes\r\n')).toBe(0)
    expect(answer('n\n')).toBe(1)
    writeFileSync(tty, '\n')
    expect(sourced(`ASK_TTY='${tty}'; ask "Delete" n`).status).toBe(1)
  })

  it('makes Node 22 the default after a typed y, even when nvm trips over errexit, and carries on', () => {
    const tty = join(root, 'tty')
    writeFileSync(tty, 'y\n')
    // nvm's own functions hit failing commands in normal operation.
    const r = sourced(
      `ASK_TTY='${tty}'
       nvm() { echo "nvm $*" >> '${calls}'; [ "$1" = version ] && { echo v20.1.0; return 0; }; false; echo "nvm $* done" >> '${calls}'; }
       SWITCHED_NODE=1
       check_default_node
       echo "carried on DEFAULT_NODE_OK=\${DEFAULT_NODE_OK:-0}"`,
    )
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(calls, 'utf-8')).toContain('nvm alias default 22 done')
    expect(r.stderr).toContain('Node 22 is now your nvm default')
    expect(r.stdout).toContain('carried on DEFAULT_NODE_OK=1')
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
