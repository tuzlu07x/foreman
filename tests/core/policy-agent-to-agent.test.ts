import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

// #656 (A): `agents.<id>.can_call` / `cannot_call` bind calls from one agent
// to another (a hand-off is `<target>:write`).

describe('can_call / cannot_call', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let engine: PolicyEngine

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    engine.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file, write]
    cannot_call:
      codex: [write]
`)
  })
  afterEach(() => {
    sqlite.close()
  })

  const call = (sourceAgent: string, targetAgent: string, targetTool: string) =>
    engine.evaluate({ sourceAgent, targetAgent, targetTool, args: {} })

  it('cannot_call denies', () => {
    expect(call('hermes', 'codex', 'write')).toMatchObject({ decision: 'deny' })
  })

  it('can_call allows what it lists and denies the rest on that agent', () => {
    expect(call('hermes', 'claude-code', 'write').decision).toBe('allow')
    expect(call('hermes', 'claude-code', 'read_file').decision).toBe('allow')
    expect(call('hermes', 'claude-code', 'shell_exec')).toEqual({ decision: 'deny', label: 'can_call' })
  })

  it('binds only the agent that has the list, and an unverified connection claiming it', () => {
    expect(call('openclaw', 'claude-code', 'shell_exec').decision).toBe('ask')
    expect(call('hermes', 'openclaw', 'write').decision).toBe('ask')
    expect(call('untrusted:hermes', 'claude-code', 'shell_exec')).toEqual({ decision: 'deny', label: 'can_call' })
    expect(call('untrusted:hermes', 'codex', 'write').decision).toBe('deny')
  })
})
