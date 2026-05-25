/**
 * spawnAcpMediated tests — full bridge + connector + spawn stack
 * driven with an in-memory fake ACP child process.
 *
 * Mirrors `codex-mediated-spawn.test.ts`. The ACP side has different
 * initialize params (protocolVersion + clientCapabilities vs codex's
 * clientInfo) but the spawn lifecycle is identical:
 *   1. spawn child with piped stdio
 *   2. initialize handshake
 *   3. caller drives session lifecycle
 *   4. shutdown SIGTERMs + bridge stops
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import {
  spawnAcpMediated,
  AcpSpawnValidationError,
  type AcpSpawnLike,
} from '../../src/core/acp-mediated-spawn.js'
import type { MediatorLike } from '../../src/core/codex-mediator-connector.js'
import type {
  MediatorInput,
  MediatorOutput,
} from '../../src/core/mediator.js'

// =============================================================================
// Fake child harness
// =============================================================================

interface FakeChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn> & ((signal?: NodeJS.Signals) => boolean)
}

interface FakeHarness {
  spawn: AcpSpawnLike
  child: FakeChild
  fromForeman: string[]
  emit(frame: unknown): void
  tick(): Promise<void>
}

function makeHarness(): FakeHarness {
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
    decidedBy: 'risk:auto-allow',
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
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
} {
  return JSON.parse(line)
}

// =============================================================================
// Initialize handshake
// =============================================================================

describe('spawnAcpMediated — initialize handshake', () => {
  it('writes initialize with default protocolVersion + capabilities', async () => {
    const h = makeHarness()
    const session = spawnAcpMediated({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
    })
    await h.tick()
    expect(h.fromForeman).toHaveLength(1)
    const init = parseFrame(h.fromForeman[0]!)
    expect(init.method).toBe('initialize')
    expect((init.params as { protocolVersion: number }).protocolVersion).toBe(1)
    expect(init.params).toHaveProperty('clientCapabilities')

    h.emit({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } })
    await expect(session.ready).resolves.toEqual({ protocolVersion: 1 })
    await session.shutdown()
  })

  it('honors capability overrides', async () => {
    const h = makeHarness()
    const session = spawnAcpMediated({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
      capabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    const caps = init.params!.clientCapabilities as {
      fs: { readTextFile: boolean; writeTextFile: boolean }
      terminal: boolean
    }
    expect(caps.fs.readTextFile).toBe(true)
    expect(caps.terminal).toBe(true)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await session.ready
    await session.shutdown()
  })

  it('honors protocolVersion override', async () => {
    const h = makeHarness()
    const session = spawnAcpMediated({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'zeroclaw',
      spawnImpl: h.spawn,
      argv: { command: 'zeroclaw', args: ['acp'] },
      protocolVersion: 2,
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    expect((init.params as { protocolVersion: number }).protocolVersion).toBe(2)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await session.ready
    await session.shutdown()
  })

  it('rejects `ready` when the agent returns an initialize error', async () => {
    const h = makeHarness()
    const session = spawnAcpMediated({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({
      jsonrpc: '2.0',
      id: init.id,
      error: { code: -32600, message: 'unsupported protocol version' },
    })
    await expect(session.ready).rejects.toThrow(/unsupported protocol version/)
    await session.shutdown()
  })
})

// =============================================================================
// Argv validation
// =============================================================================

describe('spawnAcpMediated — argv contract', () => {
  it('throws synchronously on empty argv command', () => {
    expect(() =>
      spawnAcpMediated({
        mediator: mediatorReturning('allowed'),
        sourceAgent: 'hermes',
        spawnImpl: makeHarness().spawn,
        argv: { command: '   ', args: [] },
      }),
    ).toThrow(AcpSpawnValidationError)
  })

  it('passes argv + stdio config to spawnImpl', async () => {
    const h = makeHarness()
    const session = spawnAcpMediated({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'openclaw',
      spawnImpl: h.spawn,
      argv: { command: '/usr/local/bin/openclaw', args: ['acp', '--verbose'] },
      cwd: '/tmp/work',
      env: { FOREMAN_TEST: 'yes' },
    })
    await h.tick()
    const spawnMock = h.spawn as unknown as ReturnType<typeof vi.fn>
    expect(spawnMock.mock.calls[0]![0]).toBe('/usr/local/bin/openclaw')
    expect(spawnMock.mock.calls[0]![1]).toEqual(['acp', '--verbose'])
    expect(spawnMock.mock.calls[0]![2].stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(spawnMock.mock.calls[0]![2].cwd).toBe('/tmp/work')
    expect(spawnMock.mock.calls[0]![2].env.FOREMAN_TEST).toBe('yes')
    h.emit({ jsonrpc: '2.0', id: 1, result: {} })
    await session.ready
    await session.shutdown()
  })
})

// =============================================================================
// End-to-end lifecycle — initialize → session/new → mid-prompt approval
// =============================================================================

describe('spawnAcpMediated — mid-prompt approval routes through mediator', () => {
  it('routes session/request_permission through the mediator and writes the ACP outcome back', async () => {
    const h = makeHarness()
    const mediator = mediatorReturning('allowed')
    const session = spawnAcpMediated({
      mediator,
      sourceAgent: 'hermes',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
    })

    // initialize
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await session.ready

    // caller opens a session
    const newSessionPromise = session.bridge.request('session/new', {})
    await h.tick()
    const newSessionFrame = parseFrame(h.fromForeman[1]!)
    h.emit({
      jsonrpc: '2.0',
      id: newSessionFrame.id,
      result: { sessionId: 'sess-abc' },
    })
    await expect(newSessionPromise).resolves.toEqual({ sessionId: 'sess-abc' })

    // agent emits mid-prompt approval request
    h.emit({
      jsonrpc: '2.0',
      id: 'req-perm-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-abc',
        toolCall: {
          toolCallId: 'tc-1',
          title: 'execute ls',
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

    const replyFrame = parseFrame(h.fromForeman[2]!)
    expect(replyFrame.id).toBe('req-perm-1')
    expect(replyFrame.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'A' },
    })
    expect(mediator.handleRequest).toHaveBeenCalledTimes(1)

    await session.shutdown()
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

// =============================================================================
// Shutdown
// =============================================================================

describe('spawnAcpMediated — shutdown', () => {
  it('SIGTERMs the child and stops the bridge; idempotent', async () => {
    const h = makeHarness()
    const session = spawnAcpMediated({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await session.ready

    await session.shutdown()
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')

    // shutdown is idempotent
    await session.shutdown()
    expect(h.child.kill).toHaveBeenCalledTimes(1)
  })

  it('after shutdown, requests reject cleanly', async () => {
    const h = makeHarness()
    const session = spawnAcpMediated({
      mediator: mediatorReturning('allowed'),
      sourceAgent: 'hermes',
      spawnImpl: h.spawn,
      argv: { command: 'hermes', args: ['acp'] },
    })
    await h.tick()
    const init = parseFrame(h.fromForeman[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: {} })
    await session.ready

    await session.shutdown()
    await expect(session.bridge.request('session/new')).rejects.toThrow(/stopped/)
  })
})
