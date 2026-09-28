import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FOREMAN_BIN, GiveUp, isAlive, sleep, waitFor, type Sandbox } from './sandbox.js'

// =============================================================================
// `foreman start` in a real pseudo-terminal
// =============================================================================
//
// On Linux, util-linux `script` allocates the pty. Elsewhere (macOS) a small
// Python 3 helper does (qa/support/pty-run.py, standard library only), so the
// suite needs no native npm dependency. Either way keystrokes go in through
// its stdin, the screen comes back on its stdout and is kept as plain text
// (ANSI stripped) so scenarios can wait for what a person would read, and its
// exit code is Foreman's.

/** The pty is 120×40, as `stty cols 120 rows 40` sets it. */
const COLS = 120
const ROWS = 40

const PTY_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'pty-run.py')

type PtyBackend = { kind: 'script' } | { kind: 'python'; python: string } | { kind: 'none'; reason: string }

/** The interpreter behind `python3`, as an absolute path: a version-manager
 *  shim (pyenv, asdf) would look for its own files under the sandbox HOME. */
function findPython(): string | null {
  for (const candidate of ['python3', '/usr/bin/python3']) {
    const res = spawnSync(candidate, ['-I', '-c', 'import pty, sys; print(sys.executable)'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
    const exe = res.status === 0 ? res.stdout.trim() : ''
    if (isAbsolute(exe) && existsSync(exe)) return exe
  }
  return null
}

function ptyBackend(): PtyBackend {
  if (process.env.QA_NO_PTY === '1') return { kind: 'none', reason: 'QA_NO_PTY=1 turns the pseudo-terminal journeys off' }
  if (process.platform === 'win32') return { kind: 'none', reason: 'needs a pseudo-terminal, which QA does not drive on Windows' }
  if (process.platform === 'linux') {
    return spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0
      ? { kind: 'script' }
      : { kind: 'none', reason: 'needs a pseudo-terminal: util-linux `script` on Linux' }
  }
  const python = findPython()
  return python !== null
    ? { kind: 'python', python }
    : { kind: 'none', reason: 'needs a pseudo-terminal: python3 (e.g. from the Xcode Command Line Tools) for qa/support/pty-run.py' }
}

const BACKEND = ptyBackend()

export const PTY_AVAILABLE: boolean = BACKEND.kind !== 'none'

export const PTY_SKIP_REASON: string = BACKEND.kind === 'none' ? BACKEND.reason : ''

/** The command that runs `argv` in a COLS×ROWS pty. */
function ptyCommand(argv: readonly string[]): { file: string; args: string[] } {
  switch (BACKEND.kind) {
    case 'script':
      return {
        file: 'script',
        args: ['-qfec', `stty cols ${COLS} rows ${ROWS}; exec ${argv.map(shellQuote).join(' ')}`, '/dev/null'],
      }
    case 'python':
      return { file: BACKEND.python, args: ['-I', PTY_HELPER, '--cols', String(COLS), '--rows', String(ROWS), '--', ...argv] }
    case 'none':
      throw new Error(`no pseudo-terminal: ${BACKEND.reason}`)
  }
}

/** How long the TUI ignores letter keys after the approval on screen
 *  changes (KEY_SETTLE_MS in src/tui/app.tsx is 600 ms). */
export const KEY_SETTLE_MS = 1_000

export const KEY = {
  enter: '\r',
  escape: '\u001b',
} as const

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[@-Z\\-_=>78]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r/g, '')
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export class Tui {
  private text = ''
  private pending = ''
  private readonly exited: Promise<number | null>
  private foremanPid: number | null = null

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => this.ingest(chunk))
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => this.ingest(chunk))
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  }

  /** `foreman start --skip-setup` at 120×40, waiting until the gateway runs
   *  and its daemon listens. */
  static async start(sandbox: Sandbox): Promise<Tui> {
    const { file, args } = ptyCommand([process.execPath, FOREMAN_BIN, 'start', '--skip-setup'])
    const child = spawn(file, args, {
      cwd: sandbox.cwd,
      env: sandbox.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so teardown can take the whole tree down.
      detached: true,
    })
    const tui = new Tui(child)
    sandbox.onDispose(async () => {
      await tui.stop()
    })
    const pidFile = sandbox.path('foreman.pid')
    tui.foremanPid = await waitFor('foreman start to write its pidfile', () => {
      if (child.exitCode !== null) throw new GiveUp(`foreman start exited early: ${tui.screen().slice(-2_000)}`)
      if (!existsSync(pidFile)) return null
      const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
      return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null
    })
    // Agents' `foreman mcp-stdio` and the hook only use the daemon (#616)
    // once it listens; until then they quietly serve in their own process.
    // Waiting for it makes every pty journey go through the daemon, and a
    // sandbox whose socket path is too long fail here rather than pass on
    // the in-process path.
    const socket = sandbox.path('foreman.sock')
    const token = sandbox.path('foreman.sock.token')
    await waitFor(
      `the Foreman daemon to listen on ${socket}`,
      () => {
        if (child.exitCode !== null) throw new GiveUp(`foreman start exited early: ${tui.screen().slice(-2_000)}`)
        return lstatSync(socket).isSocket() && existsSync(token)
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    )
    return tui
  }

  get pid(): number | null {
    return this.foremanPid
  }

  private ingest(chunk: string): void {
    this.pending += chunk
    // Keep an escape sequence that is still arriving for the next chunk.
    const lastEsc = this.pending.lastIndexOf('\u001b')
    const cut = lastEsc !== -1 && this.pending.length - lastEsc < 32 ? lastEsc : this.pending.length
    this.text += stripAnsi(this.pending.slice(0, cut))
    this.pending = this.pending.slice(cut)
  }

  /** Everything shown so far, as plain text. */
  screen(): string {
    return this.text
  }

  /** A position in the screen history; pass it to `waitForText` to only
   *  look at what was drawn afterwards. */
  mark(): number {
    return this.text.length
  }

  async waitForText(pattern: string | RegExp, opts: { from?: number; timeoutMs?: number } = {}): Promise<string> {
    const from = opts.from ?? 0
    const matches = (s: string): boolean => (typeof pattern === 'string' ? s.includes(pattern) : pattern.test(s))
    return waitFor(
      `"${String(pattern)}" on the TUI screen`,
      () => {
        if (this.child.exitCode !== null) throw new GiveUp(`the TUI exited: ${this.text.slice(-2_000)}`)
        const shown = this.text.slice(from)
        return matches(shown) ? shown : null
      },
      { timeoutMs: opts.timeoutMs ?? 20_000, intervalMs: 50 },
    )
  }

  /** Wait until the dashboard (not the splash) is on screen. */
  async waitForDashboard(): Promise<void> {
    await this.waitForText(/\? help/, { timeoutMs: 30_000 })
  }

  press(keys: string): void {
    this.child.stdin.write(keys)
  }

  /** Open the `:` console, type a line and run it. */
  async command(line: string, opts: { alreadyOpen?: boolean } = {}): Promise<void> {
    if (!opts.alreadyOpen) {
      const m = this.mark()
      this.press(':')
      await this.waitForText('Enter run', { from: m })
    }
    const typed = this.mark()
    this.press(line)
    await this.waitForText(line, { from: typed })
    this.press(KEY.enter)
  }

  /** SIGTERM to Foreman (what `/foreman stop` does), then make sure nothing
   *  of the process tree survives. Returns Foreman's exit code, which
   *  `script -e` and pty-run.py pass through. */
  async stop(timeoutMs = 15_000): Promise<number | null> {
    const pgid = this.child.pid
    if (this.child.exitCode === null) {
      // Signal Foreman itself: the pty runner then reaps it and exits with
      // its code. (Signalling `script` makes it forward the signal and exit
      // without reaping, which leaves a zombie behind.)
      const target = this.foremanPid !== null && isAlive(this.foremanPid) ? this.foremanPid : pgid
      try {
        if (target !== undefined) process.kill(target, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    const code = await Promise.race([this.exited, sleep(timeoutMs).then(() => null)])
    if (this.foremanPid !== null && isAlive(this.foremanPid)) {
      try {
        process.kill(this.foremanPid, 'SIGKILL')
      } catch {
        /* raced with exit */
      }
    }
    if (pgid !== undefined) {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        /* group already empty */
      }
    }
    return code
  }
}
