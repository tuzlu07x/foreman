/**
 * executeWriteDirective ACP routing tests.
 *
 * Pins the new branch added in this PR: when the target agent
 * declares `approval_adapter: 'acp-stdio-v1'` + `acp_command`, the
 * executor routes through `runAcpMediatedTask` instead of the legacy
 * `spawnAgentTask` path. Outcome is converted to SpawnAgentTaskOutcome
 * shape so the rest of the executor (Telegram relay, session
 * lifecycle) stays unchanged.
 *
 * The full ACP wire is already exercised by acp-mediated-task.test.ts;
 * here we focus on the BRANCH selection + outcome conversion + error
 * paths specific to executeWriteDirective.
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import {
  acpOutcomeToSpawn,
  executeWriteDirective,
} from '../../src/core/agent-execute.js'
import type { AcpSpawnLike } from '../../src/core/acp-mediated-spawn.js'
import type { MediatorLike } from '../../src/core/codex-mediator-connector.js'
import type {
  MediatorInput,
  MediatorOutput,
} from '../../src/core/mediator.js'
import type { AgentEntry } from '../../src/core/registry-catalog.js'

// =============================================================================
// Fake child harness for the ACP spawn
// =============================================================================

interface FakeChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn> & ((signal?: NodeJS.Signals) => boolean)
}

function makeFakeChild(): { spawn: AcpSpawnLike; child: FakeChild; lines: string[]; emit: (frame: unknown) => void } {
  const lines: string[] = []
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const part of text.split('\n')) {
        if (part.length > 0) lines.push(part)
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
    lines,
    emit(frame) {
      stdout.push(JSON.stringify(frame) + '\n')
    },
  }
}

function mediatorReturning(decision: 'allowed' | 'denied'): MediatorLike {
  return {
    handleRequest: vi.fn(
      async (_input: MediatorInput): Promise<MediatorOutput> => ({
        requestId: 'r',
        decision,
        decidedBy: 'risk:auto-allow',
        riskScore: 10,
        riskReasons: [],
        riskFactors: [],
        riskBucket: 'low',
        llmVerification: null,
        durationMs: 1,
      }),
    ),
  }
}

function acpEntry(id: string): AgentEntry {
  return {
    id,
    name: id,
    tagline: 't',
    homepage: 'https://example.com',
    install: { npm: null, brew: null, script: null, binary: id },
    config_paths: [`~/.${id}/config.toml`],
    config_snippet: null,
    identity_path: `~/.${id}/AGENTS.md`,
    mcp_servers_key: 'mcp_servers',
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: '>=0.0.0',
    min_foreman_version: '0.1.0',
    approval_adapter: 'acp-stdio-v1',
    acp_command: { command: id, args: ['acp'] },
  } as unknown as AgentEntry
}

function tick(times = 1): Promise<void> {
  return (async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setImmediate(r))
    }
  })()
}

// =============================================================================
// Branch selection
// =============================================================================

describe('executeWriteDirective — ACP routing branch', () => {
  it('returns spawn-error when an ACP agent is targeted without a mediator', async () => {
    const out = await executeWriteDirective({
      agentId: 'hermes',
      message: 'do X',
      entry: acpEntry('hermes'),
    })
    expect(out.spawn.kind).toBe('spawn-error')
    if (out.spawn.kind === 'spawn-error') {
      expect(out.spawn.error).toContain('requires deps.mediator')
    }
  })

  it('routes through runAcpMediatedTask when entry is ACP + mediator is wired', async () => {
    const h = makeFakeChild()
    const mediator = mediatorReturning('allowed')

    const promise = executeWriteDirective(
      {
        agentId: 'hermes',
        message: 'plan my morning',
        entry: acpEntry('hermes'),
      },
      {
        mediator,
        acpSpawnImpl: h.spawn,
        // Skip Telegram relay so the test stays hermetic.
        telegramBotToken: undefined,
        telegramChatId: undefined,
      },
    )

    // initialize + session/new + session/prompt — emit each response.
    await tick()
    const init = JSON.parse(h.lines[0]!)
    h.emit({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } })
    await tick()
    const newSession = JSON.parse(h.lines[1]!)
    h.emit({
      jsonrpc: '2.0',
      id: newSession.id,
      result: { sessionId: 'sess-test' },
    })
    await tick()
    const prompt = JSON.parse(h.lines[2]!)
    expect(prompt.method).toBe('session/prompt')
    // ACP spec: prompt is ContentBlock[], not raw string.
    expect(prompt.params.prompt).toEqual([
      { type: 'text', text: 'plan my morning' },
    ])
    h.emit({
      jsonrpc: '2.0',
      id: prompt.id,
      result: { reply: 'Here is your plan: A B C' },
    })

    const outcome = await promise
    expect(outcome.spawn.kind).toBe('ok')
    if (outcome.spawn.kind === 'ok') {
      // Stringified result lands on stdout.
      expect(outcome.spawn.stdout).toContain('reply')
      expect(outcome.spawn.stdout).toContain('Here is your plan')
    }
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does NOT route through ACP when entry lacks approval_adapter', async () => {
    // Legacy entry without ACP fields — falls through to the
    // task_command_template branch. Missing template → unsupported.
    const legacyEntry: AgentEntry = {
      ...acpEntry('legacy'),
      approval_adapter: undefined,
      acp_command: undefined,
    } as unknown as AgentEntry

    const out = await executeWriteDirective({
      agentId: 'legacy',
      message: 'x',
      entry: legacyEntry,
    })
    expect(out.spawn.kind).toBe('unsupported')
  })

  it('falls back to unsupported when ACP entry is missing acp_command (registry validator should catch this)', async () => {
    const broken: AgentEntry = {
      ...acpEntry('broken'),
      acp_command: undefined,
    } as unknown as AgentEntry

    // With approval_adapter set, ACP routing branch triggers. The
    // acp_command guard inside executeAcpDirective returns unsupported.
    const out = await executeWriteDirective(
      { agentId: 'broken', message: 'x', entry: broken },
      { mediator: mediatorReturning('allowed') },
    )
    // Branch check: approval_adapter AND acp_command — when
    // acp_command is missing, the branch doesn't fire and we fall
    // through to task_command_template (also missing) → unsupported.
    expect(out.spawn.kind).toBe('unsupported')
  })
})

// =============================================================================
// Outcome conversion — acpOutcomeToSpawn
// =============================================================================

describe('acpOutcomeToSpawn', () => {
  it('ok with string result → SpawnAgentTaskOutcome kind=ok with stdout=result', () => {
    const out = acpOutcomeToSpawn(
      { ok: true, result: 'agent reply', sessionId: 's' },
      1234,
    )
    expect(out).toEqual({
      kind: 'ok',
      stdout: 'agent reply',
      stderr: '',
      exitCode: 0,
      durationMs: 1234,
    })
  })

  it('ok with object result → stdout is JSON-stringified', () => {
    const out = acpOutcomeToSpawn(
      { ok: true, result: { foo: 'bar', n: 42 }, sessionId: 's' },
      1,
    )
    if (out.kind !== 'ok') throw new Error('expected ok')
    const parsed = JSON.parse(out.stdout)
    expect(parsed).toEqual({ foo: 'bar', n: 42 })
  })

  it('failure stage=timeout → SpawnAgentTaskOutcome kind=timeout', () => {
    const out = acpOutcomeToSpawn(
      { ok: false, stage: 'timeout', error: 'timed out after 1000ms' },
      1000,
    )
    expect(out.kind).toBe('timeout')
    if (out.kind === 'timeout') {
      expect(out.stderr).toContain('timed out')
    }
  })

  it('failure stage=session → kind=failed with stage on stderr', () => {
    const out = acpOutcomeToSpawn(
      { ok: false, stage: 'session', error: 'session limit reached' },
      500,
    )
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') {
      expect(out.stderr).toContain('[ACP session]')
      expect(out.stderr).toContain('session limit reached')
      expect(out.exitCode).toBe(1)
    }
  })

  it('failure stage=initialize → kind=failed with stage on stderr', () => {
    const out = acpOutcomeToSpawn(
      { ok: false, stage: 'initialize', error: 'unsupported version' },
      100,
    )
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') {
      expect(out.stderr).toContain('[ACP initialize]')
    }
  })
})
