import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

// =============================================================================
// Sandbox — one isolated Foreman install per QA scenario
// =============================================================================
//
// Every scenario gets its own temporary root with:
//   foreman/   FOREMAN_HOME (config, state, audit DB)
//   home/      HOME and the XDG dirs, so nothing reads or writes ~ for real
//   work/      the cwd of every process
//   bin/       stub agent CLIs (claude, codex, hermes, …) that print canned
//              output and never touch files; npm / npx / uvx refuse to run
//   node/      a `node` symlink, so PATH holds node and the stubs but none of
//              the real agent CLIs that live next to node on this machine
//
// The environment is built from scratch (nothing inherited from the shell),
// every Node child preloads the network guard, and `dispose()` kills
// whatever the scenario left running before deleting the root.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FOREMAN_BIN = join(REPO_ROOT, 'dist/cli/index.js')
export const DEMO_SERVER = join(REPO_ROOT, 'tests/core/mcp-hub/fixtures/demo-server.mjs')
const NET_GUARD = join(REPO_ROOT, 'qa/support/no-network.cjs')

/** Agent CLIs Foreman may spawn (tasks, daemons, ACP). All stubs. */
const STUB_AGENTS = ['claude', 'codex', 'hermes', 'openclaw', 'zeroclaw'] as const
/** Installers that must never run during QA. */
const REFUSED_TOOLS = ['npm', 'npx', 'uvx'] as const

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** A row of `foreman inbox --json`. */
export interface InboxItem {
  id: string
  createdAt: number
  level: 'info' | 'warning' | 'critical'
  kind: string
  title: string
  body: string
  requestId: string | null
  agentId: string | null
  dedupeKey: string | null
  readAt: number | null
}

export interface RunOptions {
  input?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export class Sandbox {
  private readonly cleanups: Array<() => void | Promise<void>> = []

  private constructor(
    readonly root: string,
    readonly home: string,
    readonly cwd: string,
    readonly netLog: string,
    readonly env: NodeJS.ProcessEnv,
  ) {}

  static async create(name: string): Promise<Sandbox> {
    if (!existsSync(FOREMAN_BIN)) throw new Error(`${FOREMAN_BIN} is missing: run \`npm run build\` first`)
    const root = makeRoot(name)
    const dirs = {
      home: join(root, 'foreman'),
      user: join(root, 'home'),
      cwd: join(root, 'work'),
      bin: join(root, 'bin'),
      node: join(root, 'node'),
      tmp: join(root, 'tmp'),
    }
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
    symlinkSync(process.execPath, join(dirs.node, 'node'))
    for (const agent of STUB_AGENTS) writeStub(dirs.bin, agent, agentStub(agent))
    for (const tool of REFUSED_TOOLS) writeStub(dirs.bin, tool, refusedStub(tool))
    const netLog = join(root, 'network-attempts.log')
    const env: NodeJS.ProcessEnv = {
      PATH: [dirs.bin, dirs.node, '/usr/bin', '/bin'].join(':'),
      HOME: dirs.user,
      XDG_CONFIG_HOME: join(dirs.user, '.config'),
      XDG_STATE_HOME: join(dirs.user, '.local/state'),
      XDG_CACHE_HOME: join(dirs.user, '.cache'),
      XDG_DATA_HOME: join(dirs.user, '.local/share'),
      TMPDIR: dirs.tmp,
      USER: 'qa',
      LOGNAME: 'qa',
      SHELL: '/bin/sh',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      TERM: 'xterm-256color',
      FOREMAN_HOME: dirs.home,
      FOREMAN_NO_UPDATE_CHECK: '1',
      FOREMAN_NO_AGENT_UPDATE_CHECK: '1',
      // Spend receiver on a port of its own, never the default 4319.
      FOREMAN_OTLP_PORT: String(await freePort()),
      NODE_OPTIONS: `--require ${quoteForNodeOptions(NET_GUARD)}`,
      QA_NET_LOG: netLog,
    }
    return new Sandbox(root, dirs.home, dirs.cwd, netLog, env)
  }

  /** Run the built CLI to completion (plain output, no colour). */
  run(args: readonly string[], opts: RunOptions = {}): RunResult {
    const res = spawnSync(process.execPath, [FOREMAN_BIN, ...args], {
      cwd: this.cwd,
      env: { ...this.env, NO_COLOR: '1', ...opts.env },
      encoding: 'utf-8',
      input: opts.input,
      timeout: opts.timeoutMs ?? 60_000,
      killSignal: 'SIGKILL',
    })
    if (res.error) throw new Error(`foreman ${args.join(' ')}: ${res.error.message}`)
    return { status: res.status, stdout: res.stdout, stderr: res.stderr }
  }

  /** Run a command that must succeed; returns stdout. */
  ok(args: readonly string[], opts: RunOptions = {}): string {
    const res = this.run(args, opts)
    if (res.status !== 0) {
      throw new Error(`foreman ${args.join(' ')} exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
    }
    return res.stdout
  }

  /** Run a `--json` command and parse its output. */
  json<T>(args: readonly string[], opts: RunOptions & { allowExit?: number[] } = {}): T {
    const res = this.run(args, opts)
    const allowed = opts.allowExit ?? [0]
    if (!allowed.includes(res.status ?? -1)) {
      throw new Error(`foreman ${args.join(' ')} exited ${res.status}\nstderr: ${res.stderr}`)
    }
    return JSON.parse(res.stdout) as T
  }

  /** Like `run`, but without blocking this process's event loop: use it
   *  whenever a server in this process (the webhook receiver) or a pipe
   *  from a running agent must keep being served meanwhile. */
  runAsync(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [FOREMAN_BIN, ...args], {
        cwd: this.cwd,
        env: { ...this.env, NO_COLOR: '1', ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf-8').on('data', (c: string) => (stdout += c))
      child.stderr.setEncoding('utf-8').on('data', (c: string) => (stderr += c))
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000)
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.once('close', (status) => {
        clearTimeout(timer)
        resolveRun({ status, stdout, stderr })
      })
      child.stdin.end(opts.input ?? '')
    })
  }

  async okAsync(args: readonly string[], opts: RunOptions = {}): Promise<string> {
    const res = await this.runAsync(args, opts)
    if (res.status !== 0) {
      throw new Error(`foreman ${args.join(' ')} exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
    }
    return res.stdout
  }

  /** Read-only query against the audit database. */
  query<T>(sql: string, ...params: unknown[]): T[] {
    const db = new Database(join(this.home, 'foreman.db'), { readonly: true, fileMustExist: true, timeout: 5_000 })
    try {
      return db.prepare(sql).all(...params) as T[]
    } finally {
      db.close()
    }
  }

  /** Audit events of one type, payload parsed. */
  events<T = Record<string, unknown>>(type: string): Array<T & { _at: number }> {
    return this.query<{ payload: string; created_at: number }>(
      'SELECT payload, created_at FROM audit_events WHERE event_type = ? ORDER BY id',
      type,
    ).map((r) => ({ ...(JSON.parse(r.payload) as T), _at: r.created_at }))
  }

  /** First row of `sql` once it exists (the audit logger writes in
   *  ~100 ms batches, and other processes write on their own schedule). */
  async row<T>(what: string, sql: string, ...params: unknown[]): Promise<T> {
    return waitFor(what, () => this.query<T>(sql, ...params)[0], { timeoutMs: 10_000 })
  }

  /** The latest audit event of `type` matching `match`, once it exists. */
  async event<T = Record<string, unknown>>(type: string, match: (e: T) => boolean = () => true): Promise<T & { _at: number }> {
    return waitFor(`an audit event ${type}`, () => this.events<T>(type).filter(match).at(-1), { timeoutMs: 10_000 })
  }

  /** `foreman inbox --json`, as a user would script it. */
  async inbox(limit = 50): Promise<InboxItem[]> {
    return JSON.parse(await this.okAsync(['inbox', '--json', '--limit', String(limit)])) as InboxItem[]
  }

  /** Wait until `foreman inbox --json` lists an item matching `match`. */
  async inboxItem(what: string, match: (item: InboxItem) => boolean, timeoutMs = 20_000): Promise<InboxItem> {
    return waitFor(`inbox item: ${what}`, async () => (await this.inbox()).find(match), { timeoutMs, intervalMs: 300 })
  }

  path(...parts: string[]): string {
    return join(this.home, ...parts)
  }

  write(relativeToHome: string, content: string): void {
    writeFileSync(this.path(relativeToHome), content)
  }

  read(relativeToHome: string): string {
    return readFileSync(this.path(relativeToHome), 'utf-8')
  }

  /** Non-loopback connections the guard refused (should always be empty). */
  networkAttempts(): string[] {
    if (!existsSync(this.netLog)) return []
    return readFileSync(this.netLog, 'utf-8').split('\n').filter((l) => l.trim().length > 0)
  }

  onDispose(fn: () => void | Promise<void>): void {
    this.cleanups.push(fn)
  }

  async dispose(): Promise<void> {
    for (const fn of this.cleanups.splice(0).reverse()) {
      try {
        await fn()
      } catch {
        /* keep tearing down */
      }
    }
    if (process.env.QA_KEEP !== '1') rmSync(this.root, { recursive: true, force: true })
  }
}

/** Foreman's limit on its daemon socket path (MAX_SOCKET_PATH in
 *  src/core/daemon/protocol.ts): past it, `foreman start` runs without the
 *  daemon and agents quietly serve in their own process. */
const MAX_SOCKET_PATH = 100
/** Where `foreman start` puts its socket, relative to the sandbox root. */
const SOCKET_IN_ROOT = join('foreman', 'foreman.sock')

/** A fresh sandbox root, short enough for the daemon's Unix socket. Under
 *  os.tmpdir() when that fits (Linux: /tmp); macOS's per-user $TMPDIR
 *  (/var/folders/…/T) is too long, so there it goes under /tmp/fq-*. The
 *  path is resolved (/tmp is /private/tmp on macOS), as Foreman sees its
 *  cwd. mkdtemp creates it 0700. */
function makeRoot(name: string): string {
  if (process.platform === 'win32') return mkdtempSync(join(tmpdir(), `foreman-qa-${name}-`))
  const fits = (root: string): boolean => join(root, SOCKET_IN_ROOT).length <= MAX_SOCKET_PATH
  const tmp = realpathSync(tmpdir())
  // mkdtemp appends six characters.
  const prefix = fits(join(tmp, `foreman-qa-${name}-XXXXXX`)) ? join(tmp, `foreman-qa-${name}-`) : join(realpathSync('/tmp'), `fq-${name}-`)
  const root = mkdtempSync(prefix)
  if (!fits(root)) {
    rmSync(root, { recursive: true, force: true })
    throw new Error(`the sandbox root is too long for Foreman's daemon socket: ${join(root, SOCKET_IN_ROOT)}`)
  }
  return root
}

function writeStub(dir: string, name: string, body: string): void {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function agentStub(name: string): string {
  return [
    '#!/bin/sh',
    `# QA stub for '${name}': canned output only. It never reads or writes files`,
    '# and never touches the network.',
    'case "$1" in',
    `  --version|-v|version) echo "${name} 0.0.0-qa-stub"; exit 0 ;;`,
    'esac',
    `echo "[qa-stub ${name}] received: $*"`,
    `echo "[qa-stub ${name}] done, nothing was changed"`,
    'exit 0',
    '',
  ].join('\n')
}

function refusedStub(name: string): string {
  return ['#!/bin/sh', `echo "QA: '${name}' is disabled in the sandbox" >&2`, 'exit 127', ''].join('\n')
}

function quoteForNodeOptions(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

/** A TCP port on 127.0.0.1 that was free a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Thrown from a `waitFor` probe to stop waiting at once (e.g. the process
 *  that should produce the result has exited). */
export class GiveUp extends Error {}

/** Poll `probe` until it returns something truthy. Other errors from the
 *  probe count as "not yet" (a table not written yet, a busy database). */
export async function waitFor<T>(
  what: string,
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
  let lastError: unknown = null
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
    } catch (err) {
      if (err instanceof GiveUp) throw err
      lastError = err
    }
    if (Date.now() > deadline) {
      const why = lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
      throw new Error(`timed out after ${opts.timeoutMs ?? 15_000} ms waiting for ${what}${why}`)
    }
    await sleep(opts.intervalMs ?? 100)
  }
}

/** The environment a running process was started with: Linux's
 *  /proc/<pid>/environ, or elsewhere (macOS) the same kernel record as
 *  `ps eww` prints it. `ps` joins the entries with spaces, so there an entry
 *  runs up to the next ` NAME=`; values the sandbox sets never contain one. */
export function processEnv(pid: number): Record<string, string> {
  const out: Record<string, string> = {}
  let entries: string[]
  if (process.platform === 'linux') {
    entries = readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0')
  } else {
    const argv = psField(pid, 'command')
    const withEnv = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' })
    const line = withEnv.status === 0 ? withEnv.stdout.trim() : ''
    if (argv === null || !line.startsWith(argv)) throw new Error(`cannot read the environment of pid ${pid} with ps`)
    entries = line.slice(argv.length).trim().split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)
  }
  for (const entry of entries) {
    const eq = entry.indexOf('=')
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

/** One `ps -o <field>=` column for `pid`, or null when it is gone. */
function psField(pid: number, field: string): string | null {
  const res = spawnSync('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { encoding: 'utf-8' })
  const value = res.status === 0 ? res.stdout.trim() : ''
  return value === '' ? null : value
}

/** A running process (a zombie waiting to be reaped does not count). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform !== 'linux') {
    // No /proc on macOS: ps reports a zombie's state as Z.
    const state = psField(pid, 'stat')
    return state !== null && !state.startsWith('Z')
  }
  try {
    // /proc/<pid>/stat: "pid (comm) state …"; comm may contain spaces.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z'
  } catch {
    return true
  }
}
