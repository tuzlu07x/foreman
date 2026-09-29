import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { FOREMAN_BIN, Sandbox, waitFor } from '../support/sandbox.js'

// =============================================================================
// One agent runtime, several roles
// =============================================================================
//
// A team that only uses Claude Code and Codex: `foreman agent add backend
// --type codex` and friends. Each instance runs as its own agent: Foreman
// launches Codex / Claude Code with that instance's own Foreman MCP server
// and role, so what it does is attributed to it, by name, as trusted.

const AGENT_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'support', 'company-agent.cjs')

const ORG = `# Acme QA: one Claude Code lead, two Codex and one Claude Code instance
version: 1
company: "Acme QA"
human:
  title: Founder
delegation:
  cross_department: via_heads
  skip_levels: true
departments:
  engineering:
    name: Engineering
    head: tech-lead
roles:
  tech-lead:
    title: Tech Lead
    agent: claude-code
    department: engineering
    reports_to: human
  backend-dev:
    title: Backend Developer
    agent: backend
    department: engineering
    reports_to: tech-lead
    responsibility: the login API
  frontend-dev:
    title: Frontend Developer
    agent: frontend
    department: engineering
    reports_to: tech-lead
    responsibility: the signup screens
  code-reviewer:
    title: Code Reviewer
    agent: reviewer
    department: engineering
    reports_to: tech-lead
    instructions: Review the change and report findings with file and line. Don't edit files.
    can: [read]
`

const PLAYBOOK = {
  'claude-code': [
    {
      when: 'signup feature',
      reply: 'Splitting it: API to backend, screens to frontend, review to reviewer.',
      delegate: [
        ['backend', 'Build the signup API'],
        ['frontend', 'Build the signup UI'],
        ['reviewer', 'Review the signup change'],
      ],
    },
  ],
  codex: [
    // Both Codex instances run this stand-in; the task tells them apart.
    { when: 'signup API', reply: 'API done.', post: ['engineering', 'backend: POST /api/signup is ready'], delegate: [['frontend', 'Wire the UI to POST /api/signup']] },
    { when: 'signup UI', reply: 'UI done.', post: ['engineering', 'frontend: signup screens are ready'] },
  ],
  'claude-code-reviewer': [],
} as const

interface CommandRow {
  id: number
  args: string
  source_agent: string
  status: string
}

interface AgentLogLine {
  agent: string
  task: string
  spawnedBy: string | null
  server: { command: string; args: string[]; env: Record<string, string> } | null
  argv: string[]
}

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('One runtime, several roles: two Codex and a Claude Code instance each work and talk as themselves', async (context) => {
  const j = new Journey(
    context.task,
    'agent-instances',
    'A team on Claude Code and Codex only: `agent add backend --type codex`, `frontend --type codex`, `reviewer --type claude-code`, each an org role. A feature from you flows lead → instances and between instances. Foreman launches each instance with its own Foreman MCP server and role, so its channel posts and hand-offs are attributed to it, trusted. Codex\'s own config stays wired to `codex`.',
  )
  const sb = (sandbox = await Sandbox.create('instances'))
  const bin = join(sb.root, 'bin')
  const agentLog = join(sb.root, 'agent-tasks.jsonl')
  const codexConfig = join(sb.env.HOME ?? '', '.codex', 'config.toml')
  const commands = (): CommandRow[] =>
    sb.query<CommandRow>("SELECT id, args, source_agent, status FROM control_commands WHERE command = 'write' ORDER BY id")
  const handoff = (c: CommandRow): string => `${c.source_agent} → ${JSON.parse(c.args)[0]}: ${JSON.parse(c.args)[1]}`
  const tasks = (): AgentLogLine[] =>
    existsSync(agentLog) ? readFileSync(agentLog, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentLogLine) : []

  await j.step('two Codex and one Claude Code instance next to the agents themselves; Codex\'s own config is left alone', (ev) => {
    const exe = (name: string, body: string): void => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    exe('foreman', `exec "${process.execPath}" "${FOREMAN_BIN}" "$@"`)
    exe('codex', `exec node "${AGENT_JS}" codex task "$@"`)
    exe('claude', `exec node "${AGENT_JS}" claude-code task "$@"`)
    sb.ok(['init'])
    sb.ok(['agent', 'add', 'codex'])
    sb.ok(['agent', 'add', 'claude-code'])
    const wired = readFileSync(codexConfig, 'utf-8')
    expect(wired).toContain('"--source"')
    expect(wired).toContain('"codex"')
    for (const [name, type] of [['backend', 'codex'], ['frontend', 'codex'], ['reviewer', 'claude-code']]) {
      const out = sb.ok(['agent', 'add', name!, '--type', type!])
      expect(out).toContain(`${name} runs as its own`)
    }
    expect(readFileSync(codexConfig, 'utf-8')).toBe(wired)
    ev('agent add codex / claude-code wire their configs; backend, frontend (--type codex) and reviewer (--type claude-code): "runs as its own …"')
    ev('~/.codex/config.toml is byte-for-byte what `agent add codex` wrote (still --source codex)')
    sb.write('org.yaml', ORG)
    expect(sb.run(['org', 'validate']).status).toBe(0)
    writeFileSync(join(sb.root, 'playbook.json'), JSON.stringify(PLAYBOOK, null, 2))
    sb.env.QA_PLAYBOOK = join(sb.root, 'playbook.json')
    sb.env.QA_AGENT_LOG = agentLog
    ev('org.yaml: tech-lead=claude-code, backend-dev=backend, frontend-dev=frontend, code-reviewer=reviewer (engineering)')
  })

  let service: ChildProcess | null = null
  await j.step('the background service runs the gateway', async (ev) => {
    let log = ''
    const child = spawn(process.execPath, [FOREMAN_BIN, 'daemon', '--service'], { cwd: sb.cwd, env: { ...sb.env, NO_COLOR: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr!.setEncoding('utf-8').on('data', (c: string) => (log += c))
    sb.onDispose(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r))
        child.kill('SIGKILL')
        await exited
      }
    })
    service = child
    await waitFor('the service daemon to listen', () => log.includes('daemon: listening on'), { timeoutMs: 30_000 })
    ev(`foreman daemon --service (pid ${child.pid})`)
  })

  await j.step('a feature from you flows to the instances and between them, each hop run as the instance', async (ev) => {
    sb.ok(['write', 'claude-code', 'Ship the signup feature'])
    const rows = await waitFor(
      'five hand-offs to finish',
      () => {
        const done = commands().filter((c) => c.status !== 'pending')
        return done.length >= 5 ? done : null
      },
      { timeoutMs: 90_000, intervalMs: 300 },
    )
    expect(rows.map(handoff).sort()).toEqual(
      [
        'cli → claude-code: Ship the signup feature',
        'claude-code → backend: Build the signup API',
        'claude-code → frontend: Build the signup UI',
        'claude-code → reviewer: Review the signup change',
        'backend → frontend: Wire the UI to POST /api/signup',
      ].sort(),
    )
    expect(rows.every((r) => r.status === 'applied'), JSON.stringify(rows)).toBe(true)
    for (const r of rows) ev(`control_commands #${r.id} ${handoff(r)} → ${r.status}`)
    const byTask = (task: string): AgentLogLine => {
      const line = tasks().find((t) => t.task.endsWith(task))
      expect(line, task).toBeDefined()
      return line!
    }
    // backend is Codex, launched as backend: its own server, its role.
    const backend = byTask('Build the signup API')
    expect(backend).toMatchObject({ agent: 'codex', spawnedBy: 'backend' })
    expect(backend.server?.args.slice(-3)).toEqual(['mcp-stdio', '--source', 'backend'])
    expect(backend.server?.env.FOREMAN_AGENT_TOKEN_FILE).toMatch(/agent-tokens\/backend\.token$/)
    expect(backend.task).toContain('You are Backend Developer (role "backend-dev" in Engineering) at Acme QA')
    expect(backend.argv.join(' ')).not.toMatch(/fat_[A-Za-z0-9_-]{8,}/)
    // reviewer is Claude Code, launched as reviewer, its role as a system prompt.
    const reviewer = byTask('Review the signup change')
    expect(reviewer).toMatchObject({ agent: 'claude-code', spawnedBy: 'reviewer' })
    expect(reviewer.server?.args.slice(-3)).toEqual(['mcp-stdio', '--source', 'reviewer'])
    expect(reviewer.argv).toContain('--append-system-prompt')
    expect(reviewer.argv.join(' ')).toContain("Review the change and report findings with file and line. Don't edit files.")
    // The lead is the agent itself: launched as before.
    expect(byTask('Ship the signup feature')).toMatchObject({ agent: 'claude-code', spawnedBy: 'claude-code', server: null })
    ev(`backend: codex exec … -c mcp_servers.foreman.args=[…,"--source","backend"] -c mcp_servers.foreman.env={FOREMAN_AGENT_TOKEN_FILE=…/agent-tokens/backend.token}; its task starts "You are Backend Developer …"`)
    ev('reviewer: claude --print … --mcp-config {foreman: --source reviewer} --append-system-prompt "You are Code Reviewer …"; the lead (claude-code itself) launches as before')
  })

  await j.step('each instance posts through its own server and Foreman knows who said what, trusted', async (ev) => {
    const posts = await waitFor(
      'the two instance posts',
      () => {
        const rows = sb.query<{ from_agent: string; channel: string; text: string }>(
          "SELECT from_agent, channel, text FROM org_messages WHERE channel = 'dept:engineering' ORDER BY ts",
        )
        return rows.length >= 2 ? rows : null
      },
      { timeoutMs: 30_000 },
    )
    expect(posts.map((p) => `${p.from_agent}: ${p.text}`).sort()).toEqual(
      ['backend: backend: POST /api/signup is ready', 'frontend: frontend: signup screens are ready'].sort(),
    )
    const events = sb.events<{ sourceAgent: string; ok: boolean }>('org:message').filter((e) => e.ok)
    expect(events.map((e) => e.sourceAgent).sort()).toEqual(['backend', 'frontend'])
    ev(`org_messages #engineering: ${posts.map((p) => `${p.from_agent} "${p.text}"`).join('; ')} — posted by the instances' own mcp-stdio, as themselves (not untrusted:, not codex)`)
  })

  await j.step("the reviewer's role may only read: Claude Code's hook refuses its edits and shell, not the lead's", (ev) => {
    const hook = (tool: object, spawnedBy?: string) =>
      sb.run(['hook', 'claude-code', '--timeout-ms', '300'], {
        input: JSON.stringify(tool),
        env: spawnedBy ? { FOREMAN_SPAWNED_BY: spawnedBy } : {},
      })
    const write = { tool_name: 'Write', tool_input: { file_path: join(sb.cwd, 'review.md'), content: 'LGTM' } }
    const bash = { tool_name: 'Bash', tool_input: { command: 'git status' } }
    const read = { tool_name: 'Read', tool_input: { file_path: join(sb.cwd, 'README.md') } }
    const w = hook(write, 'reviewer')
    expect(w.status).toBe(2)
    expect(w.stderr).toContain('Write blocked by Foreman: Code Reviewer (code-reviewer) may not write files: this role may only read files')
    expect(hook(bash, 'reviewer').status).toBe(2)
    expect(hook(read, 'reviewer').status).toBe(0)
    expect(hook(bash).status).toBe(0)
    const rows = sb.query<{ source_agent: string; target_tool: string; decided_by: string }>(
      "SELECT source_agent, target_tool, decided_by FROM requests WHERE decided_by = 'org:role' ORDER BY created_at",
    )
    expect(rows.map((r) => `${r.source_agent} ${r.target_tool}`)).toEqual(['reviewer file_write', 'reviewer shell_exec'])
    ev(`FOREMAN_SPAWNED_BY=reviewer: Write → exit 2 "${w.stderr.trim()}"; Bash → exit 2; Read → exit 0`)
    ev('claude-code itself (the lead, no role limits): Bash git status → exit 0')
    ev(`audit: ${rows.map((r) => `${r.source_agent} ${r.target_tool} → ${r.decided_by}`).join('; ')}`)
  })

  await j.step('removing an instance takes its token file with it', (ev) => {
    const tokenFile = sb.path('agent-tokens', 'backend.token')
    expect(existsSync(tokenFile)).toBe(true)
    sb.ok(['agent', 'remove', 'backend', '--yes'])
    expect(existsSync(tokenFile)).toBe(false)
    ev('foreman agent remove backend --yes: agent-tokens/backend.token is gone')
    const svc = service as ChildProcess | null
    svc?.kill('SIGTERM')
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback attempts')
  })
})
