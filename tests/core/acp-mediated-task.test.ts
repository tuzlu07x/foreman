/**
 * runAcpMediatedTask tests — full lifecycle on an in-memory fake ACP child.
 *
 * Mirrors `codex-mediated-task.test.ts`. The ACP shape is structurally
 * simpler than codex's because `session/prompt`'s response IS the
 * completion signal — there's no separate completion notification to
 * race against the timeout.
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import { runAcpMediatedTask } from '../../src/core/acp-mediated-task.js'
import type { AcpSpawnLike } from '../../src/core/acp-mediated-spawn.js'
import type { MediatorLike } from '../../src/core/codex-mediator-connector.js'
import type {
  MediatorInput,
  MediatorOutput,
} from '../../src/core/mediator.js'

// =============================================================================
// Fake child harness — same shape as the spawn-helper tests
// =============================================================================

interface FakeChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn> & ((signal?: NodeJS.Signals) => boolean)
}

interface Harness {
  spawn: AcpSpawnLike
  child: FakeChild
  fromForeman: string[]
  emit(frame: unknown): void
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

  const spawn: AcpSpawnLike = vi.fn(() => child as unknown as ChildProcess)
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

function mediatorReturning(decision: 'allowed' | 'denied'): MediatorLike {
  const output: MediatorOutput = {
    requestId: 'req',
    decision,
    decidedBy: decision === 'allowed' ? 'risk:auto-allow' : 'risk:auto-deny',
    riskScore: 10,
    riskReasons: [],
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
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
} {
  return JSON.parse(line)
}

/** Walk the canonical happy-path frames: initialize → session/new.
 *  Returns the harness's view of the run state so the test can emit
 *  prompt-time frames against it. */
async function walkToSessionReady(
  h: Harness,
  sessionId = 'sess-fixture',
): Promise<void> {
  await h.tick()
  const init = parseFrame(h.fromForeman[0]!)
  h.emit({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } })
  await h.tick()
  const newSession = parseFrame(h.fromForeman[1]!)
  h.emit({ jsonrpc: '2.0', id: newSession.id, result: { sessionId } })
  await h.tick()
}

// =============================================================================
// Happy path
// =============================================================================

describe('runAcpMediatedTask — happy path', () => {
  it('initialize → session/new → session/prompt → returns the prompt response', async () => {
    const h = makeHarness()
    const mediator = mediatorReturning('allowed')

    const taskPromise = runAcpMediatedTask({
      mediator,
      sourceAgent: 'hermes',
      prompt: 'plan my morning',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 5000,
    })

    await walkToSessionReady(h, 'sess-1')

    // session/prompt frame is the 3rd written frame
    const promptFrame = parseFrame(h.fromForeman[2]!)
    expect(promptFrame.method).toBe('session/prompt')
    expect((promptFrame.params as { sessionId: string }).sessionId).toBe('sess-1')
    expect((promptFrame.params as { prompt: string }).prompt).toBe(
      'plan my morning',
    )

    h.emit({
      jsonrpc: '2.0',
      id: promptFrame.id,
      result: { reply: 'here is your plan' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.sessionId).toBe('sess-1')
      expect(outcome.result).toEqual({ reply: 'here is your plan' })
    }
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('routes mid-prompt session/request_permission through the mediator', async () => {
    const h = makeHarness()
    const mediator = mediatorReturning('allowed')

    const taskPromise = runAcpMediatedTask({
      mediator,
      sourceAgent: 'hermes',
      prompt: 'do the thing',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 5000,
    })

    await walkToSessionReady(h, 'sess-perm')
    const promptFrame = parseFrame(h.fromForeman[2]!)

    // Agent emits a mid-prompt approval
    h.emit({
      jsonrpc: '2.0',
      id: 'approval-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-perm',
        toolCall: {
          toolCallId: 'tc-1',
          title: 'run ls',
          kind: 'execute',
          rawInput: { command: 'ls /tmp' },
        },
        options: [
          { optionId: 'A', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'R', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    })
    await h.tick()
    await h.tick()

    // Reply is the 4th frame (init + new + prompt + approval-reply).
    const approvalReply = parseFrame(h.fromForeman[3]!)
    expect(approvalReply.id).toBe('approval-1')
    expect(approvalReply.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'A' },
    })
    expect(mediator.handleRequest).toHaveBeenCalledTimes(1)

    h.emit({
      jsonrpc: '2.0',
      id: promptFrame.id,
      result: { reply: 'done' },
    })
    const outcome = await taskPromise
    expect(outcome.ok).toBe(true)
  })
})

// =============================================================================
// Failure modes
// =============================================================================

describe('runAcpMediatedTask — failure modes', () => {
  it('stage=initialize when the agent returns an init error', async () => {
    const h = makeHarness()
    const taskPromise = runAcpMediatedTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      prompt: 'x',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 5000,
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({
      jsonrpc: '2.0',
      id: init.id,
      error: { code: -32600, message: 'unsupported protocol version' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('initialize')
      expect(outcome.error).toMatch(/unsupported protocol version/)
    }
  })

  it('stage=session when session/new errors', async () => {
    const h = makeHarness()
    const taskPromise = runAcpMediatedTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      prompt: 'x',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 5000,
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await h.tick()
    const newSession = parseFrame(h.fromForeman[1]!)
    h.emit({
      jsonrpc: '2.0',
      id: newSession.id,
      error: { code: -32603, message: 'session limit reached' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('session')
      expect(outcome.error).toMatch(/session limit reached/)
    }
  })

  it('stage=session when session/new response is missing sessionId', async () => {
    const h = makeHarness()
    const taskPromise = runAcpMediatedTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      prompt: 'x',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 5000,
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await h.tick()
    const newSession = parseFrame(h.fromForeman[1]!)
    h.emit({ jsonrpc: '2.0', id: newSession.id, result: { extraField: 1 } })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('session')
      expect(outcome.error).toMatch(/sessionId/)
    }
  })

  it('stage=prompt when session/prompt errors', async () => {
    const h = makeHarness()
    const taskPromise = runAcpMediatedTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      prompt: 'x',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 5000,
    })
    await walkToSessionReady(h, 'sess-fail')
    const promptFrame = parseFrame(h.fromForeman[2]!)
    h.emit({
      jsonrpc: '2.0',
      id: promptFrame.id,
      error: { code: -32603, message: 'model api down' },
    })

    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('prompt')
      expect(outcome.error).toMatch(/model api down/)
      expect(outcome.sessionId).toBe('sess-fail')
    }
  })

  it('stage=timeout when the prompt never resolves', async () => {
    const h = makeHarness()
    const taskPromise = runAcpMediatedTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      prompt: 'x',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 50,
    })
    await walkToSessionReady(h, 'sess-hang')
    // No prompt response — let the timeout fire.
    const outcome = await taskPromise
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('timeout')
      expect(outcome.error).toMatch(/timed out/)
      expect(outcome.sessionId).toBe('sess-hang')
    }
  })

  it('always shuts down the child even on failure', async () => {
    const h = makeHarness()
    const taskPromise = runAcpMediatedTask({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      prompt: 'x',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      timeoutMs: 50,
    })
    await walkToSessionReady(h, 'sess-cleanup')
    await taskPromise
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
