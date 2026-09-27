import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { FOREMAN_BIN, GiveUp, isAlive, sleep, waitFor, type Sandbox } from './sandbox.js'

// =============================================================================
// `foreman start` in a real pseudo-terminal
// =============================================================================
//
// util-linux `script` allocates the pty (Linux only). Keystrokes go in through
// its stdin; the screen comes back on its stdout and is kept as plain text
// (ANSI stripped) so scenarios can wait for what a person would read.

export const PTY_AVAILABLE: boolean =
  process.env.QA_NO_PTY !== '1' &&
  process.platform === 'linux' &&
  spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0

export const PTY_SKIP_REASON = 'needs a pseudo-terminal: util-linux `script` on Linux'

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

  /** `foreman start --skip-setup` at 120×40, waiting until the gateway runs. */
  static async start(sandbox: Sandbox): Promise<Tui> {
    const command = `stty cols 120 rows 40; exec ${shellQuote(process.execPath)} ${shellQuote(FOREMAN_BIN)} start --skip-setup`
    const child = spawn('script', ['-qfec', command, '/dev/null'], {
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
   *  `script -e` passes through. */
  async stop(timeoutMs = 15_000): Promise<number | null> {
    const pgid = this.child.pid
    if (this.child.exitCode === null) {
      // Signal Foreman itself: `script` then reaps it and exits with its
      // code. (Signalling `script` makes it forward the signal and exit
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
