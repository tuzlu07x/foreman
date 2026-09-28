import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { UsageLedger } from '../../src/core/usage/ledger.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

// #656 (C): `rate_limits.tokens_per_hour` is enforced from the spend ledger.

describe('rate_limits.tokens_per_hour', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let engine: PolicyEngine
  let ledger: UsageLedger

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    engine.loadYamlText(`
rules:
  - source: "*"
    target: tool:read_file
    effect: allow
agents:
  Hermes:
    rate_limits:
      tokens_per_hour: 1000
`)
    ledger = new UsageLedger(db)
  })
  afterEach(() => {
    sqlite.close()
  })

  const read = (sourceAgent: string) => engine.evaluate({ sourceAgent, targetTool: 'read_file', args: { path: 'a.md' } })

  it('denies once the agent used its tokens in the last hour, by the rate-limit rule', () => {
    ledger.record({ agentId: 'hermes', source: 'telemetry', input: 400, output: 200, model: 'x', costUsd: 0 })
    expect(read('Hermes').decision).toBe('allow')
    ledger.record({ agentId: 'hermes', source: 'task-output', input: 300, output: 150, model: 'x', costUsd: 0 })
    const denied = read('Hermes')
    expect(denied.decision).toBe('deny')
    const rule = engine.list().find((r) => r.id === denied.matchedRuleId)!
    expect(rule.conditions).toContain('tokensPerHour')
    // An unverified connection claiming the id is held to it too.
    expect(read('untrusted:Hermes').decision).toBe('deny')
  })

  it('only counts the last hour, and only that agent', () => {
    ledger.record({ agentId: 'hermes', source: 'telemetry', input: 5000, output: 0, model: 'x', costUsd: 0, ts: Date.now() - 2 * 3_600_000 })
    ledger.record({ agentId: 'codex', source: 'telemetry', input: 5000, output: 0, model: 'x', costUsd: 0 })
    expect(read('Hermes').decision).toBe('allow')
    expect(read('codex').decision).toBe('allow')
  })
})
