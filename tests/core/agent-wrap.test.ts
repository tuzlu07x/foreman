/**
 * AgentWrap tests (#445 PR 2).
 *
 * Drives the full wrap orchestrator with an in-memory fake child + fake
 * Telegram fetch so we cover the integration without spawning a real
 * process. Coverage:
 *
 *   - validation: missing input_protocol → throws; non-stdin_jsonl
 *     method → throws; non-telegram-update schema → throws.
 *   - happy path: poller forwards owner updates as JSONL frames to
 *     child stdin.
 *   - shutdown: SIGTERMs the child + stops the poller; idempotent.
 *   - child stdin closed mid-flight: drops the update gracefully via
 *     onError instead of crashing.
 *   - child exit promise resolves with the exit code/signal.
 */

import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import {
  AgentWrapValidationError,
  startAgentWrap,
  type WrapSpawnLike,
} from '../../src/core/agent-wrap.js'
import { ControlChannel } from '../../src/core/control-channel.js'
import type { AgentEntry } from '../../src/core/registry-catalog.js'
import type {
  PollerFetchLike,
  TelegramUpdate,
} from '../../src/core/telegram-poller.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

// =============================================================================
// Harness — fake child + fake fetch in one bundle
// =============================================================================

interface FakeChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn> & ((signal?: NodeJS.Signals) => boolean)
}

function makeFakeChild(): { spawn: WrapSpawnLike; child: FakeChild; stdinLines: string[] } {
  const stdinLines: string[] = []
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const part of text.split('\n')) {
        if (part.length > 0) stdinLines.push(part)
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
  const spawn: WrapSpawnLike = vi.fn(() => child as unknown as ChildProcess)
  return { spawn, child, stdinLines }
}

interface FakeFetchHandle {
  fetch: PollerFetchLike
  enqueueUpdates(updates: TelegramUpdate[]): void
  callCount(): number
}

function makeFakeFetch(): FakeFetchHandle {
  const queue: Array<{ ok: boolean; status: number; body: unknown }> = []
  let calls = 0
  const fetch: PollerFetchLike = async () => {
    calls += 1
    if (queue.length === 0) {
      // hang — simulates long-poll waiting for an update
      return new Promise<never>(() => {
        /* never resolves */
      })
    }
    const r = queue.shift()!
    return {
      ok: r.ok,
      status: r.status,
      async json() {
        return r.body
      },
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
      },
    }
  }
  return {
    fetch,
    enqueueUpdates(updates) {
      queue.push({ ok: true, status: 200, body: { ok: true, result: updates } })
    },
    callCount() {
      return calls
    },
  }
}

const OWNER = 12345

function ownerMessage(text: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      from: { id: OWNER, is_bot: false },
      chat: { id: OWNER, type: 'private' },
      text,
    },
  }
}

function tick(times = 1): Promise<void> {
  return (async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setImmediate(r))
    }
  })()
}

/**
 * Build a minimal AgentEntry-shaped object good enough for the wrap
 * code paths under test. The full schema has many required fields; we
 * cast to AgentEntry since this test never round-trips through zod.
 */
function entryWithInputProtocol(
  overrides: Partial<AgentEntry['input_protocol']> = {},
): AgentEntry {
  return {
    id: 'fixture-agent',
    input_protocol: {
      method: 'stdin_jsonl',
      schema: 'telegram-update',
      synthetic_update_template: { update_id: '{auto}' },
      ...overrides,
    },
  } as unknown as AgentEntry
}

// =============================================================================
// Validation
// =============================================================================

describe('startAgentWrap — validation', () => {
  it('throws when the registry entry has no input_protocol', () => {
    expect(() =>
      startAgentWrap({
        entry: { id: 'a' } as unknown as AgentEntry,
        botToken: 't',
        ownerChatId: OWNER,
        childArgv: { command: 'echo', args: [] },
      }),
    ).toThrow(AgentWrapValidationError)
  })

  it('throws on non-stdin_jsonl method', () => {
    const entry = entryWithInputProtocol({
      method: 'http_post' as unknown as 'stdin_jsonl',
    })
    expect(() =>
      startAgentWrap({
        entry,
        botToken: 't',
        ownerChatId: OWNER,
        childArgv: { command: 'echo', args: [] },
      }),
    ).toThrow(/stdin_jsonl/)
  })

  it('throws on non-telegram-update schema', () => {
    const entry = entryWithInputProtocol({
      schema: 'discord-event' as unknown as 'telegram-update',
    })
    expect(() =>
      startAgentWrap({
        entry,
        botToken: 't',
        ownerChatId: OWNER,
        childArgv: { command: 'echo', args: [] },
      }),
    ).toThrow(/telegram-update/)
  })
})

// =============================================================================
// Happy path
// =============================================================================

describe('startAgentWrap — happy path', () => {
  it('spawns the child + forwards owner updates as JSONL to its stdin', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    fetchH.enqueueUpdates([ownerMessage('hi from user', 99)])

    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: ['--mode', 'wrap'] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
    })

    await tick(5)

    // Child was spawned with the right argv.
    const spawnMock = childH.spawn as unknown as ReturnType<typeof vi.fn>
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]![0]).toBe('fake-agent')
    expect(spawnMock.mock.calls[0]![1]).toEqual(['--mode', 'wrap'])
    expect(spawnMock.mock.calls[0]![2].stdio).toEqual(['pipe', 'pipe', 'pipe'])

    // Update was written as JSONL.
    expect(childH.stdinLines).toHaveLength(1)
    const parsed = JSON.parse(childH.stdinLines[0]!)
    expect(parsed.update_id).toBe(99)
    expect(parsed.message.text).toBe('hi from user')

    await handle.shutdown()
  })

  it('does NOT forward non-owner updates (owner filter inherited from poller)', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    fetchH.enqueueUpdates([
      {
        update_id: 100,
        message: {
          from: { id: 99999, is_bot: false },
          chat: { id: 99999, type: 'private' },
          text: 'stranger',
        },
      },
    ])

    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
    })

    await tick(5)
    expect(childH.stdinLines).toHaveLength(0)
    await handle.shutdown()
  })

  it('forwards multiple updates in arrival order', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    fetchH.enqueueUpdates([
      ownerMessage('first', 200),
      ownerMessage('second', 201),
      ownerMessage('third', 202),
    ])

    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
    })

    await tick(5)
    expect(childH.stdinLines).toHaveLength(3)
    expect(JSON.parse(childH.stdinLines[0]!).message.text).toBe('first')
    expect(JSON.parse(childH.stdinLines[2]!).message.text).toBe('third')

    await handle.shutdown()
  })
})

// =============================================================================
// Shutdown
// =============================================================================

describe('startAgentWrap — shutdown', () => {
  it('SIGTERMs the child and stops the poller; idempotent', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
    })
    await tick(2)
    await handle.shutdown()
    expect(childH.child.kill).toHaveBeenCalledWith('SIGTERM')

    // shutdown again — must not re-kill.
    await handle.shutdown()
    expect(childH.child.kill).toHaveBeenCalledTimes(1)
  })

  it('exited resolves when the child fires its exit event', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
    })
    await tick(2)
    // Simulate the child exiting normally.
    childH.child.emit('exit', 0, null)
    const result = await handle.exited
    expect(result).toEqual({ code: 0, signal: null })
    await handle.shutdown()
  })
})

// =============================================================================
// Failure modes — child stdin closed mid-flight
// =============================================================================

describe('startAgentWrap — failure modes', () => {
  it('handle.directiveSource is null when no controlChannel is supplied (PR 2 behaviour preserved)', () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
    })
    expect(handle.directiveSource).toBeNull()
    void handle.shutdown()
  })

  it('drops updates silently when the child stdin is destroyed (no crash)', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    const errors: Error[] = []
    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
      onError(err) {
        errors.push(err)
      },
    })
    // Tear down the child's stdin mid-flight.
    childH.child.stdin.destroy()
    fetchH.enqueueUpdates([ownerMessage('after destroy', 500)])
    await tick(5)

    // No update made it through (stdin was destroyed before write).
    expect(childH.stdinLines).toHaveLength(0)
    // No error was raised — we drop on destroyed-stdin path silently.
    expect(errors).toHaveLength(0)

    await handle.shutdown()
  })
})

// =============================================================================
// PR 3 — directive injection from #440 control_commands
// =============================================================================

describe('startAgentWrap — directive injection (#445 PR 3)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let channel: ControlChannel

  beforeEach(() => {
    const h = createInMemoryDb()
    db = h.db
    sqlite = h.sqlite
    channel = new ControlChannel(db)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('renders the synthetic_update_template + writes the directive as JSONL to child stdin', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    // Enqueue a write directive BEFORE starting the wrap so the
    // first drain picks it up.
    channel.enqueue({
      command: 'write',
      args: ['fixture-agent', 'focus on issue Y'],
      sourceAgent: 'cli',
    })

    const handle = startAgentWrap({
      entry: entryWithInputProtocol({
        synthetic_update_template: {
          update_id: '{auto}',
          message: {
            from: { id: '{ownerChatId}', is_bot: false },
            chat: { id: '{ownerChatId}', type: 'private' },
            text: '{directive}',
          },
        },
      }),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
      controlChannel: channel,
      directivePollIntervalMs: 60_000, // never tick; drive via drainOnce
    })

    // The directive source drains immediately on start; tick to let
    // the async handler resolve.
    await tick(5)

    expect(handle.directiveSource).not.toBeNull()
    expect(childH.stdinLines).toHaveLength(1)
    const parsed = JSON.parse(childH.stdinLines[0]!)
    expect(parsed.message.from.id).toBe(OWNER)
    expect(parsed.message.chat.id).toBe(OWNER)
    expect(parsed.message.text).toBe('focus on issue Y')
    expect(typeof parsed.update_id).toBe('number')

    await handle.shutdown()
  })

  it('marks the directive row applied after successful injection', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    const { id } = channel.enqueue({
      command: 'write',
      args: ['fixture-agent', 'ack me'],
      sourceAgent: 'cli',
    })

    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
      controlChannel: channel,
      directivePollIntervalMs: 60_000,
    })
    await tick(5)
    expect(channel.get(id)?.status).toBe('applied')

    await handle.shutdown()
  })

  it('directive rows for OTHER agents are ignored', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    const { id: otherId } = channel.enqueue({
      command: 'write',
      args: ['some-other-agent', 'not for me'],
      sourceAgent: 'cli',
    })

    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
      controlChannel: channel,
      directivePollIntervalMs: 60_000,
    })
    await tick(5)

    expect(childH.stdinLines).toHaveLength(0)
    expect(channel.get(otherId)?.status).toBe('pending')

    await handle.shutdown()
  })

  it('marks directive failed when child stdin is closed', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    childH.child.stdin.destroy()

    const { id } = channel.enqueue({
      command: 'write',
      args: ['fixture-agent', 'will fail'],
      sourceAgent: 'cli',
    })

    const handle = startAgentWrap({
      entry: entryWithInputProtocol(),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
      controlChannel: channel,
      directivePollIntervalMs: 60_000,
    })
    await tick(5)

    const row = channel.get(id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('stdin closed')

    await handle.shutdown()
  })

  it('Telegram updates AND directives both write to child stdin (the same path)', async () => {
    const childH = makeFakeChild()
    const fetchH = makeFakeFetch()
    fetchH.enqueueUpdates([ownerMessage('from user', 1)])
    channel.enqueue({
      command: 'write',
      args: ['fixture-agent', 'from foreman'],
      sourceAgent: 'cli',
    })

    const handle = startAgentWrap({
      // Use a real telegram-update-shaped template so both paths
      // produce frames with `message.text`.
      entry: entryWithInputProtocol({
        synthetic_update_template: {
          update_id: '{auto}',
          message: {
            from: { id: '{ownerChatId}', is_bot: false },
            chat: { id: '{ownerChatId}', type: 'private' },
            text: '{directive}',
          },
        },
      }),
      botToken: 'TEST',
      ownerChatId: OWNER,
      childArgv: { command: 'fake-agent', args: [] },
      spawnImpl: childH.spawn,
      fetchImpl: fetchH.fetch,
      controlChannel: channel,
      directivePollIntervalMs: 60_000,
    })
    await tick(10)

    expect(childH.stdinLines).toHaveLength(2)
    // Both reach the child — order isn't guaranteed because directive
    // drain happens in start() before the Telegram fetch settles, but
    // both messages MUST land.
    const texts = childH.stdinLines.map((l) => JSON.parse(l).message.text)
    expect(texts).toContain('from user')
    expect(texts).toContain('from foreman')

    await handle.shutdown()
  })
})
