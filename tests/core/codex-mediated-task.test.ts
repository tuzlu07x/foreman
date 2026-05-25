/**
 * Mediated codex task runner tests (#552 PR 7).
 *
 * Drives `runMediatedCodexTask` against an in-memory fake codex process
 * to exercise the full lifecycle:
 *
 *   spawn → initialize → thread/start → turn/start →
 *     (optional mid-turn approvals) → turn/completed → shutdown
 *
 * Two slices:
 *
 *   1. Low-risk auto-allow (Task #9) — codex emits a commandExecution
 *      approval request mid-turn; the mediator returns `allowed`; the
 *      bridge writes `{ decision: 'accept' }` back; codex completes the
 *      turn; runner returns ok with status: 'completed'.
 *
 *   2. High-risk denial (Task #10 — fake-mediator slice) — codex emits
 *      a commandExecution approval request; the mediator returns
 *      `denied`; the bridge writes `{ decision: 'decline' }` back;
 *      codex finishes the turn with whatever status it chose (we
 *      assert the wire decline + the outcome shape, not codex's
 *      internal post-decline behaviour, which is out of our control).
 *
 *      The actual end-to-end "user types /approve in chat → mediator
 *      unblocks the JSON-RPC reply" path lives in the
 *      mcp-stdio-approval-id-hints + submit_approval tests already
 *      shipped in PR 5; what THIS test pins is that high-risk denials
 *      from the mediator propagate as wire declines into codex.
 *
 *   3. Failure modes — initialize error, thread/start error, timeout,
 *      transport error — each surfaces as `{ ok: false, stage, error }`
 *      so an upstream caller can route incident handling.
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import { runMediatedCodexTask } from '../../src/core/codex-mediated-task.js'
import type { CodexSpawnLike } from '../../src/core/codex-mediated-spawn.js'
import type { MediatorLike } from '../../src/core/codex-mediator-connector.js'
import type {
  MediatorInput,
  MediatorOutput,
} from '../../src/core/mediator.js'

// =============================================================================
// Fake codex child harness — reused from PR 4 with small additions
// =============================================================================

interface FakeChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn> & ((signal?: NodeJS.Signals) => boolean)
}

interface Harness {
  spawn: CodexSpawnLike
  child: FakeChild
  /** JSON-RPC frames Foreman wrote to the child. */
  fromForeman: string[]
  /** Push a JSON-RPC frame as if codex emitted it. */
  emit(frame: unknown): void
  /** Synchronously wait one microtask tick. */
  tick(): Promise<void>
}

function makeHarness(): Harness {
  const fromForeman: string[] = []
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const part of text.split('\n')) {
        if (part.length > 0) fromForeman.push(part)
      }
      cb()
    },
  })
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  const child = new EventEmitter() as FakeChild
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.kill = vi.fn((_s?: NodeJS.Signals) => true) as FakeChild['kill']

  const spawn: CodexSpawnLike = vi.fn(() => child as unknown as ChildProcess)
  return {
    spawn,
    child,
    fromForeman,
    emit(frame) {
      stdout.push(JSON.stringify(frame) + '\n')
    },
    tick() {
      return new Promise((r) => setImmediate(r))
    },
  }
}

function mediatorReturning(
  decision: 'allowed' | 'denied',
  decidedBy = 'risk:auto-allow',
  riskReasons: string[] = [],
): MediatorLike {
  const output: MediatorOutput = {
    requestId: 'req',
    decision,
    decidedBy,
    riskScore: 10,
    riskReasons,
    riskFactors: [],
    riskBucket: 'low',
    llmVerification: null,
    durationMs: 1,
  }
  return {
    handleRequest: vi.fn(
      async (_input: MediatorInput): Promise<MediatorOutput> => output,
    ),
  }
}

function parseFrame(line: string): {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
} {
  return JSON.parse(line)
}

/**
 * Walk the canonical happy-path frames: initialize → thread/start →
 * turn/start. Returns the harness + the turnId codex assigned so the
 * test can emit mid-turn approval / completion frames against it.
 */
async function walkToTurnStart(
  h: Harness,
  threadId = 'thread_X',
  turnId = 'turn_Y',
): Promise<{ initId: number | string; turnId: string }> {
  await h.tick()
  const init = parseFrame(h.fromForeman[0]!)
  h.emit({ jsonrpc: '2.0', id: init.id, result: { ok: true } })
  await h.tick()
  const thread = parseFrame(h.fromForeman[1]!)
  h.emit({ jsonrpc: '2.0', id: thread.id, result: { threadId } })
  await h.tick()
  const turn = parseFrame(h.fromForeman[2]!)
  h.emit({ jsonrpc: '2.0', id: turn.id, result: { turnId } })
  await h.tick()
  return { initId: init.id ?? 0, turnId }
}

// =============================================================================
// 1. Low-risk auto-allow (Task #9)
// =============================================================================

describe('runMediatedCodexTask — low-risk auto-allow (Task #9)', () => {
  it('completes a turn whose mid-turn approval is auto-allowed by the mediator', async () => {
    const h = makeHarness()
    const mediator = mediatorReturning('allowed', 'risk:auto-allow')

    const taskPromise = runMediatedCodexTask({
      mediator,
      sourceAgent: 'codex',
      prompt: 'ls /tmp',
      cwd: '/tmp',
      spawnImpl: h.spawn,
      timeoutMs: 5000,
    })

    await walkToTurnStart(h)

    // Mid-turn approval request from codex.
    h.emit({
      jsonrpc: '2.0',
      id: 'aprv-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item_X',
        threadId: 'thread_X',
        turnId: 'turn_Y',
        startedAtMs: 1,
        command: 'ls /tmp',
        cwd: '/tmp',
        reason: null,
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        availableDecisions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        approvalId: null,
      },
    })
    await h.tick()
    await h.tick()

    // The 4th frame is the approval reply.
    const approvalReply = parseFrame(h.fromForeman[3]!)
    expect(approvalReply.id).toBe('aprv-1')
    expect(approvalReply.result).toEqual({ decision: 'accept' })

    // Turn completion notification.
    h.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turnId: 'turn_Y', status: 'completed' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.status).toBe('completed')
      expect(outcome.threadId).toBe('thread_X')
      expect(outcome.turnId).toBe('turn_Y')
    }
    expect(mediator.handleRequest).toHaveBeenCalledTimes(1)
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

// =============================================================================
// 2. High-risk → mediator denies → wire decline (Task #10, fake slice)
// =============================================================================

describe('runMediatedCodexTask — high-risk → mediator denies (Task #10)', () => {
  it('writes wire decline back when the mediator denies', async () => {
    const h = makeHarness()
    const mediator = mediatorReturning('denied', 'risk:auto-deny', [
      'destructive_rm',
    ])

    const taskPromise = runMediatedCodexTask({
      mediator,
      sourceAgent: 'codex',
      prompt: 'rm -rf /tmp/scratch',
      cwd: '/tmp',
      spawnImpl: h.spawn,
      timeoutMs: 5000,
    })

    await walkToTurnStart(h)

    h.emit({
      jsonrpc: '2.0',
      id: 'risky-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'rm_X',
        threadId: 'thread_X',
        turnId: 'turn_Y',
        startedAtMs: 1,
        command: 'rm -rf /tmp/scratch',
        cwd: '/tmp',
        reason: 'cleanup',
        commandActions: null,
        networkApprovalContext: null,
        additionalPermissions: null,
        availableDecisions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        approvalId: null,
      },
    })
    await h.tick()
    await h.tick()

    const reply = parseFrame(h.fromForeman[3]!)
    expect(reply.id).toBe('risky-1')
    expect(reply.result).toEqual({ decision: 'decline' })

    // Codex finishes the turn after the decline.
    h.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turnId: 'turn_Y', status: 'completed_with_declines' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.status).toBe('completed_with_declines')
    }
  })
})

// =============================================================================
// 3. Failure-mode coverage
// =============================================================================

describe('runMediatedCodexTask — failure modes', () => {
  it('reports stage=initialize when initialize errors', async () => {
    const h = makeHarness()
    const mediator = mediatorReturning('allowed')
    const taskPromise = runMediatedCodexTask({
      mediator,
      sourceAgent: 'codex',
      prompt: 'irrelevant',
      spawnImpl: h.spawn,
      timeoutMs: 5000,
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({
      jsonrpc: '2.0',
      id: init.id,
      error: { code: -32602, message: 'unsupported client' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('initialize')
      expect(outcome.error).toMatch(/unsupported client/)
    }
  })

  it('reports stage=thread when thread/start errors', async () => {
    const h = makeHarness()
    const taskPromise = runMediatedCodexTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'codex',
      prompt: 'irrelevant',
      spawnImpl: h.spawn,
      timeoutMs: 5000,
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await h.tick()
    const thread = parseFrame(h.fromForeman[1]!)
    h.emit({
      jsonrpc: '2.0',
      id: thread.id,
      error: { code: -32602, message: 'cwd not absolute' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('thread')
      expect(outcome.error).toMatch(/cwd not absolute/)
    }
  })

  it('reports stage=thread when thread/start returns no threadId', async () => {
    const h = makeHarness()
    const taskPromise = runMediatedCodexTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'codex',
      prompt: 'irrelevant',
      spawnImpl: h.spawn,
      timeoutMs: 5000,
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await h.tick()
    const thread = parseFrame(h.fromForeman[1]!)
    h.emit({ jsonrpc: '2.0', id: thread.id, result: { somethingElse: 1 } })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('thread')
      expect(outcome.error).toMatch(/threadId/)
    }
  })

  it('reports stage=timeout when the turn never completes', async () => {
    const h = makeHarness()
    const taskPromise = runMediatedCodexTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'codex',
      prompt: 'irrelevant',
      spawnImpl: h.spawn,
      timeoutMs: 50,
    })
    await walkToTurnStart(h)
    // No turn/completed notification — let the timeout fire.
    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('timeout')
      expect(outcome.error).toMatch(/timed out/)
    }
  })

  it('always shuts down the child even on failure', async () => {
    const h = makeHarness()
    const taskPromise = runMediatedCodexTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'codex',
      prompt: 'irrelevant',
      spawnImpl: h.spawn,
      timeoutMs: 50,
    })
    await walkToTurnStart(h)
    await taskPromise
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

// =============================================================================
// 4. Method-name resilience for turn-completion
// =============================================================================

describe('runMediatedCodexTask — completion-method resilience', () => {
  it('also accepts turn/closed as the completion notification (codex schema drift safety)', async () => {
    const h = makeHarness()
    const taskPromise = runMediatedCodexTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'codex',
      prompt: 'noop',
      spawnImpl: h.spawn,
      timeoutMs: 5000,
    })
    await walkToTurnStart(h)
    h.emit({
      jsonrpc: '2.0',
      method: 'turn/closed',
      params: { turnId: 'turn_Y', status: 'completed' },
    })
    const outcome = await taskPromise
    expect(outcome.ok).toBe(true)
  })

  it('also accepts thread/turn/completed (codex schema drift safety)', async () => {
    const h = makeHarness()
    const taskPromise = runMediatedCodexTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'codex',
      prompt: 'noop',
      spawnImpl: h.spawn,
      timeoutMs: 5000,
    })
    await walkToTurnStart(h)
    h.emit({
      jsonrpc: '2.0',
      method: 'thread/turn/completed',
      params: { turnId: 'turn_Y', status: 'completed' },
    })
    const outcome = await taskPromise
    expect(outcome.ok).toBe(true)
  })

  it('ignores completion notifications for other turn ids', async () => {
    const h = makeHarness()
    const taskPromise = runMediatedCodexTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'codex',
      prompt: 'noop',
      spawnImpl: h.spawn,
      timeoutMs: 80,
    })
    await walkToTurnStart(h)
    h.emit({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turnId: 'some-other-turn', status: 'completed' },
    })
    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('timeout')
    }
  })
})
