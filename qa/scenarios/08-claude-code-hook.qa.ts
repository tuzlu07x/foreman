import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { FOREMAN_BIN, Sandbox, sleep, type RunResult } from '../support/sandbox.js'
import { KEY_SETTLE_MS, PTY_AVAILABLE, PTY_SKIP_REASON, Tui } from '../support/tui.js'

// The Claude Code PreToolUse hook, end to end: `foreman agent hook install
// claude-code` writes ~/.claude/settings.json, and every payload below goes
// through the hook command exactly as that file says to run it (`sh -c`,
// payload on stdin, exit 0 = run the tool, exit 2 = block it), which is what
// Claude Code does. No real agent CLI runs: this scenario is the agent.

interface SettingsHook {
  type?: string
  command?: string
  timeout?: number
  managed_by?: string
}

interface ClaudeSettings {
  hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: SettingsHook[] }> }
}

interface RequestRow {
  id: string
  target_tool: string
  args: string
  decision: string
  decided_by: string
  risk_bucket: string
  risk_score: number
}

interface PendingRow {
  status: string
  decision: string | null
  resolved_by: string | null
}

const HOOK_BIN = join(FOREMAN_BIN, '..', 'hook.js')
const REQUEST_COLUMNS = 'id, target_tool, args, decision, decided_by, risk_bucket, risk_score'

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('Claude Code PreToolUse hook: install, allow, approve and deny in the TUI, fail closed', async (context) => {
  const j = new Journey(
    context.task,
    'claude-code-hook',
    '`foreman agent hook install claude-code` wires Foreman into Claude Code\'s `settings.json`. PreToolUse payloads are then piped into the hook command exactly as that file says to run it: a harmless call passes, risky calls wait for `a` / `d` in the TUI, policy denies without asking, and every failure blocks the call (exit 2).',
  )
  const sb = (sandbox = await Sandbox.create('claude-code-hook'))
  const userHome = sb.env.HOME ?? ''
  const settingsPath = join(userHome, '.claude', 'settings.json')
  let hookCommand = ''

  /** Pipe a PreToolUse payload into the hook the way Claude Code runs it. */
  const hook = (payload: string, opts: { args?: string; env?: Record<string, string>; timeoutMs?: number } = {}) =>
    runShell(sb, opts.args ? withArgs(hookCommand, opts.args) : hookCommand, payload, opts.env, opts.timeoutMs)
  const payload = (sessionId: string, toolName: string, toolInput: Record<string, unknown>): string =>
    JSON.stringify({
      session_id: sessionId,
      transcript_path: join(userHome, '.claude', 'projects', 'qa', `${sessionId}.jsonl`),
      cwd: sb.cwd,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    })

  await j.step('`foreman init` and `foreman agent hook install claude-code` write ~/.claude/settings.json', (ev) => {
    sb.ok(['init'])
    // An npm install puts both binaries on PATH; here they are the built CLI.
    const bin = join(sb.root, 'bin')
    writeExecutable(join(bin, 'foreman'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FOREMAN_BIN)} "$@"\n`)
    writeExecutable(join(bin, 'foreman-hook'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(HOOK_BIN)} "$@"\n`)
    ev('PATH: `foreman` → node dist/cli/index.js, `foreman-hook` → node dist/cli/hook.js (sandbox bin/); the installed hook uses neither')

    const out = sb.ok(['agent', 'hook', 'install', 'claude-code'])
    expect(out).toContain('Installed PreToolUse hook for claude-code')
    expect(out).toContain(settingsPath)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings
    const groups = settings.hooks?.PreToolUse ?? []
    expect(groups).toHaveLength(1)
    const [group] = groups
    const entry = group?.hooks?.[0]
    // Pinned by absolute path, never looked up on PATH, and wrapped so a
    // hook that can't run blocks the call (#714).
    expect(entry).toMatchObject({ type: 'command', timeout: 660, managed_by: 'foreman.pre-tool-use' })
    hookCommand = entry?.command ?? ''
    expect(hookCommand.indexOf(process.execPath)).toBeLessThan(hookCommand.indexOf(HOOK_BIN))
    expect(hookCommand).toMatch(/ claude-code; s=\$\?;/)
    expect(hookCommand).toContain('so this call is blocked')
    const matcher = new RegExp(`^(?:${group?.matcher ?? ''})$`)
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'mcp__github__create_issue']) {
      expect(matcher.test(tool), tool).toBe(true)
    }
    expect(matcher.test('TodoWrite')).toBe(false)
    ev(`${settingsPath.slice(sb.root.length + 1)}: PreToolUse command "${hookCommand}", timeout ${entry?.timeout}s, managed_by ${entry?.managed_by}`)
    ev(`matcher "${group?.matcher}" matches Bash, Read, Write, Edit, WebFetch and mcp__* tools, not TodoWrite`)

    const again = sb.ok(['agent', 'hook', 'install', 'claude-code'])
    expect(again).toContain('hook already installed for claude-code')
    expect((JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings).hooks?.PreToolUse).toHaveLength(1)
    ev('a second install reports "hook already installed" and leaves a single entry')
  })

  await j.step('the pinned hook needs nothing on PATH, and one whose program is gone blocks the call', async (ev) => {
    // Claude Code's PATH may have no Foreman at all (another nvm default).
    const bare = await runShell(sb, hookCommand, payload('qa-hook-nopath', 'Bash', { command: 'ls' }), { PATH: '/usr/bin:/bin' })
    expect(bare.status, bare.stderr).toBe(0)
    ev(`with PATH=/usr/bin:/bin the hook still runs: exit ${bare.status}`)
    // Node moved or Foreman uninstalled: the shell can't start it (127). Claude Code would run the call; the wrapper blocks it.
    const gone = await runShell(sb, hookCommand.replace(HOOK_BIN, join(sb.root, 'gone', 'hook.js')), payload('qa-hook-gone', 'Bash', { command: 'ls' }))
    expect(gone.status).toBe(2)
    expect(gone.stderr).toContain("Foreman's hook could not run")
    ev(`hook.js moved away: exit ${gone.status}, "${gone.stderr.trim().split('\n').at(-1)}"`)
    const doctor = sb.json<{ checks: Array<{ name: string; status: string; message: string }> }>(['doctor', '--json'], { allowExit: [0, 1, 2] })
    expect(doctor.checks.find((c) => c.name === 'claude_hook')).toMatchObject({ status: 'ok', message: expect.stringContaining('pinned to this Foreman') })
    ev('foreman doctor --json: claude_hook ok, pinned to this Foreman')
  })

  await j.step('a harmless call (Bash `ls -la`) passes: exit 0, allowed and audited', async (ev) => {
    const res = await hook(payload('qa-hook-allow', 'Bash', { command: 'ls -la' }))
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('Bash allowed')
    ev(`\`${hookCommand}\` exit ${res.status}, stdout empty; stderr: "${res.stderr.trim()}"`)
    const row = await sb.row<RequestRow>('the requests row', `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ?`, 'qa-hook-allow')
    expect(row).toMatchObject({ target_tool: 'shell_exec', decision: 'allowed', decided_by: 'policy:hook:risk-based', risk_bucket: 'low' })
    expect(JSON.parse(row.args)).toEqual({ cmd: 'ls -la' })
    ev(`requests ${row.id}: claude-code → shell_exec {"cmd":"ls -la"}, allowed by ${row.decided_by} (risk ${row.risk_score}, ${row.risk_bucket})`)
    const log = sb.json<Array<{ id: string; decision: string; sourceAgent: string }>>(['log', 'tail', '--json', '-n', '5'])
    expect(log.find((r) => r.id === row.id)).toMatchObject({ decision: 'allowed', sourceAgent: 'claude-code' })
    ev('`foreman log tail --json` lists it as allowed for claude-code')
    const pending = sb.query<{ n: number }>('SELECT count(*) AS n FROM pending_approvals')[0]
    expect(pending?.n).toBe(0)
    ev('no approval was asked for (pending_approvals is empty)')
  })

  if (!PTY_AVAILABLE) {
    j.note(`Skipped approve / deny in the TUI: ${PTY_SKIP_REASON}`)
  } else {
    const tui = await j.step('`foreman start` boots the TUI in a pty', async (ev) => {
      const t = await Tui.start(sb)
      await t.waitForDashboard()
      expect(t.screen()).toContain('nothing waiting')
      ev(`foreman start pid ${t.pid}; dashboard shows "nothing waiting"`)
      return t
    })

    /** A risky call through the hook; resolves once the TUI shows it. */
    const riskyCall = async (sessionId: string, path: string, ev: (line: string) => void) => {
      const mark = tui.mark()
      const run = hook(payload(sessionId, 'Read', { file_path: path }), { timeoutMs: 90_000 })
      const shown = path.slice(path.lastIndexOf('/', path.lastIndexOf('/') - 1) + 1)
      const screen = await tui.waitForText(shown, { from: mark })
      expect(screen).toContain('read_file')
      expect(screen).toContain('claude-code')
      const pending = await sb.row<PendingRow & { request_id: string; risk_bucket: string }>(
        'a pending approval',
        "SELECT request_id, status, decision, resolved_by, risk_bucket FROM pending_approvals WHERE args LIKE ? AND status = 'pending'",
        `%${path}%`,
      )
      ev(`the hook waits; TUI shows claude-code → read_file(…/${shown}); pending_approvals ${pending.request_id} (risk ${pending.risk_bucket})`)
      return { run, requestId: pending.request_id }
    }

    await j.step('a risky call (Read <work>/.env) waits for approval; `a`, then `y`, in the TUI lets it run', async (ev) => {
      const { run, requestId } = await riskyCall('qa-hook-approve', join(sb.cwd, '.env'), ev)
      // Letter keys are ignored for a moment after the approval on screen changes.
      await sleep(KEY_SETTLE_MS)
      // A high-risk call takes a second key (#656): `a` asks, `y` allows.
      const asked = tui.mark()
      tui.press('a')
      await tui.waitForText('Allow this HIGH-risk call', { from: asked })
      tui.press('y')
      const res = await run
      expect(res.status, res.stderr).toBe(0)
      expect(res.stderr).toContain('Read allowed')
      ev(`hook exit ${res.status}; stderr: "${res.stderr.trim()}"`)
      const row = await sb.row<RequestRow>('the requests row', `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`, requestId)
      expect(row).toMatchObject({ target_tool: 'read_file', decision: 'allowed', risk_bucket: 'high' })
      expect(row.decided_by).toBe('user:tui')
      const pending = await sb.row<PendingRow>('the resolved approval', 'SELECT status, decision, resolved_by FROM pending_approvals WHERE request_id = ?', requestId)
      expect(pending).toEqual({ status: 'resolved', decision: 'allowed', resolved_by: 'user' })
      ev(`requests ${requestId}: allowed, decided_by=${row.decided_by}; pending_approvals: resolved_by=user`)
      const item = await sb.inboxItem('the allowed approval', (i) => i.requestId === requestId && i.title.startsWith('Allowed'))
      expect(item.title).toBe('Allowed read_file for claude-code')
      ev(`foreman inbox --json: "${item.title}" / "${item.body}"`)
    })

    await j.step('a second risky call (Read ~/.ssh/id_rsa); `d` in the TUI blocks it: exit 2', async (ev) => {
      const { run, requestId } = await riskyCall('qa-hook-deny', join(userHome, '.ssh', 'id_rsa'), ev)
      await sleep(KEY_SETTLE_MS)
      tui.press('d')
      const res = await run
      expect(res.status, res.stderr).toBe(2)
      expect(res.stderr).toContain('Read blocked by Foreman')
      ev(`hook exit ${res.status}; stderr: "${res.stderr.trim()}"`)
      const row = await sb.row<RequestRow>('the requests row', `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`, requestId)
      expect(row).toMatchObject({ target_tool: 'read_file', decision: 'denied' })
      expect(row.decided_by).toBe('user:tui')
      const pending = await sb.row<PendingRow>('the resolved approval', 'SELECT status, decision, resolved_by FROM pending_approvals WHERE request_id = ?', requestId)
      expect(pending).toEqual({ status: 'resolved', decision: 'denied', resolved_by: 'user' })
      ev(`requests ${requestId}: denied, decided_by=${row.decided_by} (risk ${row.risk_score}, ${row.risk_bucket}); pending_approvals: resolved_by=user`)
    })

    await j.step('`foreman start` shuts down cleanly', async (ev) => {
      const code = await tui.stop()
      expect(code).toBe(0)
      expect(existsSync(sb.path('foreman.pid'))).toBe(false)
      ev(`SIGTERM → foreman start exited ${code}, pidfile removed`)
    })
  }

  await j.step('the hook fails closed: bad payloads, a broken database, an unanswered approval', async (ev) => {
    const blocked = async (what: string, res: RunResult, stderr: string | RegExp) => {
      expect(res.status, `${what}: ${res.stderr}`).toBe(2)
      if (typeof stderr === 'string') expect(res.stderr).toContain(stderr)
      else expect(res.stderr).toMatch(stderr)
      ev(`${what} → exit ${res.status}: "${res.stderr.trim().split('\n')[0]}"`)
    }
    const harmless = payload('qa-hook-broken', 'Bash', { command: 'ls -la' })

    await blocked('malformed JSON', await hook('{"tool_name":"Bash",'), 'could not parse the PreToolUse payload')
    await blocked('an empty payload', await hook(''), 'empty PreToolUse payload')
    await blocked('JSON without tool_name', await hook('{"tool_input":{"command":"ls"}}'), 'malformed PreToolUse payload')

    const corrupt = join(sb.root, 'corrupt-home')
    mkdirSync(corrupt)
    writeFileSync(join(corrupt, 'foreman.db'), 'this is not a SQLite database\n'.repeat(200))
    await blocked('a corrupt foreman.db', await hook(harmless, { env: { FOREMAN_HOME: corrupt } }), 'is not a valid Foreman database')

    const unreadable = join(sb.root, 'unreadable-home')
    mkdirSync(join(unreadable, 'foreman.db'), { recursive: true })
    await blocked('a foreman.db that cannot be opened (a directory)', await hook(harmless, { env: { FOREMAN_HOME: unreadable } }), 'unable to open database file')
    expect(sb.query<{ n: number }>("SELECT count(*) AS n FROM requests WHERE session_id = 'qa-hook-broken'")[0]?.n).toBe(0)

    // A FOREMAN_HOME with no database at all is created on first use rather
    // than refused; the call is still mediated (risk engine, audit).
    const missing = join(sb.root, 'missing-home')
    const fresh = await hook(harmless, { env: { FOREMAN_HOME: missing } })
    ev(`no database yet (fresh FOREMAN_HOME) → exit ${fresh.status}, foreman.db created: ${existsSync(join(missing, 'foreman.db'))}`)
    j.note(
      `With FOREMAN_HOME pointing at an empty directory the hook creates and migrates a new foreman.db and mediates the call there (a harmless Bash call exited ${fresh.status}); only a database that exists but cannot be opened blocks.`,
    )

    const started = Date.now()
    const timedOut = await hook(payload('qa-hook-timeout', 'Read', { file_path: join(sb.cwd, 'deploy', '.env.production') }), {
      args: '--timeout-ms 1500',
    })
    await blocked('a risky call nobody answers (no TUI, --timeout-ms 1500)', timedOut, 'blocked by Foreman (approval-timeout')
    expect(Date.now() - started).toBeLessThan(15_000)
    const row = await sb.row<RequestRow>('the requests row', `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ?`, 'qa-hook-timeout')
    expect(row).toMatchObject({ decision: 'denied', decided_by: 'approval-timeout' })
    const pending = await sb.row<PendingRow>('the timed-out approval', 'SELECT status, decision, resolved_by FROM pending_approvals WHERE request_id = ?', row.id)
    expect(pending).toEqual({ status: 'resolved', decision: 'denied', resolved_by: 'timeout' })
    ev(`requests ${row.id}: denied by approval-timeout after ${Date.now() - started} ms; pending_approvals: resolved_by=timeout`)
  })

  await j.step('a policy.yaml deny rule blocks a Bash command without asking', async (ev) => {
    const doc = parseDocument(sb.read('policy.yaml'))
    doc.addIn(['rules'], {
      source: 'claude-code',
      target: 'tool:shell_exec',
      effect: 'deny',
      conditions: { commandMatch: ['terraform destroy'] },
    })
    sb.write('policy.yaml', doc.toString())
    ev('policy.yaml: deny claude-code → tool:shell_exec when the command contains "terraform destroy"')
    const res = await hook(payload('qa-hook-policy', 'Bash', { command: 'terraform destroy -auto-approve' }))
    expect(res.status, res.stderr).toBe(2)
    expect(res.stderr).toContain('Bash blocked by Foreman')
    ev(`hook exit ${res.status}; stderr: "${res.stderr.trim()}"`)
    const row = await sb.row<RequestRow>('the requests row', `SELECT ${REQUEST_COLUMNS} FROM requests WHERE session_id = ?`, 'qa-hook-policy')
    expect(row.decision).toBe('denied')
    expect(row.decided_by).toMatch(/^policy/)
    const asked = sb.query<{ n: number }>('SELECT count(*) AS n FROM pending_approvals WHERE request_id = ?', row.id)[0]
    expect(asked?.n).toBe(0)
    ev(`requests ${row.id}: denied, decided_by=${row.decided_by}; no pending approval was created`)
    // A Bash call the rule does not match still passes untouched: one
    // denied command doesn't make every later command suspect.
    const other = await hook(payload('qa-hook-policy-other', 'Bash', { command: 'ls -la' }), { args: '--timeout-ms 1500' })
    expect(other.status, other.stderr).toBe(0)
    ev('`ls -la` (not matched by the rule) still exits 0')
    // The rule still blocks the command itself, every time.
    const repeat = await hook(payload('qa-hook-policy-repeat', 'Bash', { command: 'terraform destroy -auto-approve' }))
    expect(repeat.status).toBe(2)
    ev(`repeating \`terraform destroy\` → exit ${repeat.status} again`)
  })

  await j.step('nothing tried to reach the network', (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback connection attempts')
  })
})

/** `sh -c <command>` with the payload on stdin, in the sandbox, as Claude
 *  Code runs a command hook. Does not block the event loop, so the TUI's
 *  screen keeps being read while the hook waits for a decision. */
function runShell(sb: Sandbox, command: string, input: string, env: Record<string, string> = {}, timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: sb.cwd,
      env: { ...sb.env, NO_COLOR: '1', CLAUDE_PROJECT_DIR: sb.cwd, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group: `sh` may fork the hook rather than exec it, and
      // a kill must take both down (the hook holds the pipes open).
      detached: true,
    })
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    sb.onDispose(kill)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8').on('data', (c: string) => (stdout += c))
    child.stderr.setEncoding('utf-8').on('data', (c: string) => (stderr += c))
    const timer = setTimeout(kill, timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      resolveRun({ status, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The hook command with extra arguments for the hook itself (before the
 *  wrapper's `; s=$?`). */
function withArgs(command: string, args: string): string {
  return command.replace(/ claude-code;/, ` claude-code ${args};`)
}
