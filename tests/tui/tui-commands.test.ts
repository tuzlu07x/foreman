import { describe, expect, it, vi } from 'vitest'
import {
  completeCommand,
  executeCommand,
  stripMarkdown,
  tokenize,
  type CommandEnv,
} from '../../src/tui/tui-commands.js'

function env(over: Partial<CommandEnv> = {}): CommandEnv & { dispatched: Array<[string, string[]]> } {
  const dispatched: Array<[string, string[]]> = []
  return {
    dispatched,
    dispatch: vi.fn(async (verb: string, args: string[]) => {
      dispatched.push([verb, args])
      return { ok: true, text: `**done** ${verb} \`${args.join(' ')}\`` }
    }),
    verbs: () => [
      { verb: 'status', description: 'Summary.' },
      { verb: 'write', description: 'Send a directive. `/foreman write <agent> <message>`.' },
      { verb: 'assign', description: 'Give a task.' },
      { verb: 'agents', description: 'Alias of `status`.' },
    ],
    navigate: vi.fn(),
    approvals: {
      current: () => 'req-1',
      describe: (id: string) => (id === 'req-1' ? 'shell_exec for codex' : 'read_file for hermes'),
      count: () => 2,
      resolve: vi.fn(),
    },
    inbox: { markAllRead: () => 3 },
    agentIds: () => ['claude-code', 'codex', 'hermes'],
    orgTargets: () => ['engineering', 'marketing', 'cto'],
    quit: vi.fn(),
    ...over,
  }
}

describe('tokenize', () => {
  it('drops a leading : or / and splits on whitespace', () => {
    expect(tokenize(':write  codex   fix it ')).toEqual(['write', 'codex', 'fix', 'it'])
    expect(tokenize('/status')).toEqual(['status'])
  })
})

describe('executeCommand (#612)', () => {
  it('runs chat verbs through the router and shows plain text', async () => {
    const e = env()
    const out = await executeCommand('write codex add tests', e)
    expect(e.dispatched).toEqual([['write', ['codex', 'add', 'tests']]])
    expect(out).toEqual({ ok: true, lines: ['done write codex add tests'] })
  })

  it('passes free-form agent-first lines to the router too', async () => {
    const e = env()
    await executeCommand('codex fix the build', e)
    expect(e.dispatched).toEqual([['codex', ['fix', 'the', 'build']]])
  })

  // QA #657 L10 — free text went to Foreman's LLM without a word, and an
  // unknown command pointed at `/foreman help` (chat syntax).
  it("says when free text was answered by Foreman's LLM", async () => {
    const e = env({ dispatch: vi.fn(async () => ({ ok: true, text: 'All quiet.', answeredByLlm: true })) })
    expect(await executeCommand('foo bar', e)).toEqual({
      ok: true,
      lines: ["Not a command, so Foreman's LLM answers (`help` lists the commands):", 'All quiet.'],
    })
  })

  it('says "unknown command" when no LLM takes free text', async () => {
    const e = env({
      dispatch: vi.fn(async () => ({ ok: false, text: 'Unknown command "foo".', errorCode: 'UNKNOWN_COMMAND' as const })),
    })
    const out = await executeCommand('foo bar', e)
    expect(out.ok).toBe(false)
    expect(out.lines[0]).toBe('Unknown command "foo". Type `help` for the list.')
    expect(out.lines[1]).toContain('foreman llm enable orchestrator_chat')
  })

  it('approves or denies exactly the approval on screen', async () => {
    const e = env()
    const allowed = await executeCommand('approve', e)
    expect(e.approvals.resolve).toHaveBeenCalledWith('req-1', { decision: 'allowed' })
    expect(allowed.lines[0]).toBe('Allowed shell_exec for codex. 1 more waiting.')
    await executeCommand('deny always', e)
    expect(e.approvals.resolve).toHaveBeenLastCalledWith('req-1', { decision: 'denied', remember: 'deny' })
  })

  it('refuses when the approval on screen changed while the line was typed', async () => {
    const e = env()
    const out = await executeCommand('approve always', e, { approvalAtStart: 'req-0' })
    expect(e.approvals.resolve).not.toHaveBeenCalled()
    expect(out.ok).toBe(false)
    expect(out.lines[0]).toContain('changed while you were typing')
    expect(out.lines[0]).toContain('shell_exec for codex')
    // Started with nothing on screen: an approval that arrived since is not the target either.
    expect((await executeCommand('approve', e, { approvalAtStart: null })).ok).toBe(false)
    expect((await executeCommand('approve', e, { approvalAtStart: 'req-1' })).ok).toBe(true)
  })

  it('says so when nothing is waiting', async () => {
    const out = await executeCommand('approve', env({ approvals: { current: () => null, describe: () => null, count: () => 0, resolve: vi.fn() } }))
    expect(out).toEqual({ ok: false, lines: ['Nothing is waiting for approval.'] })
  })

  it('navigates, marks the inbox read and clears', async () => {
    const e = env()
    await executeCommand('open keys', e)
    expect(e.navigate).toHaveBeenCalledWith('secrets')
    expect((await executeCommand('inbox read', e)).lines).toEqual(['Marked 3 notifications read.'])
    expect((await executeCommand('clear', e)).clear).toBe(true)
    expect((await executeCommand('open nowhere', e)).ok).toBe(false)
  })

  it('lists local and router commands in help, without aliases', async () => {
    const out = await executeCommand('help', env())
    const text = out.lines.join('\n')
    expect(text).toContain('approve [always]')
    expect(text).toContain('assign')
    expect(text).not.toContain('Alias')
    expect(text).not.toContain('/foreman write')
  })

  it('reports a router failure instead of throwing', async () => {
    const out = await executeCommand('status', env({ dispatch: async () => { throw new Error('db locked') } }))
    expect(out).toEqual({ ok: false, lines: ['Failed: db locked'] })
  })
})

describe('completeCommand', () => {
  it('completes the verb, then agent ids for write, then org targets for assign', () => {
    const e = env()
    expect(completeCommand('wr', e).line).toBe('write ')
    expect(completeCommand('write co', e)).toEqual({ line: 'write codex ', candidates: ['codex'] })
    expect(completeCommand('assign mar', e).line).toBe('assign marketing ')
    expect(completeCommand('open inb', e).line).toBe('open inbox ')
    expect(completeCommand('open integrations', e).line).toBe('open integrations ')
  })

  it('offers candidates when ambiguous and extends the common prefix', () => {
    const e = env({ agentIds: () => ['claude-code', 'claude-desktop'] })
    const c = completeCommand('write cl', e)
    expect(c.candidates).toEqual(['claude-code', 'claude-desktop'])
    expect(c.line).toBe('write claude-')
  })

  it('stays quiet past the first argument', () => {
    expect(completeCommand('write codex fi', env())).toEqual({ line: null, candidates: [] })
  })
})

describe('stripMarkdown', () => {
  it('drops chat formatting and the /foreman prefix', () => {
    expect(stripMarkdown('Try `/foreman write codex` **now**')).toBe('Try write codex now')
  })
})
