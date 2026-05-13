import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalService } from '../../src/core/approval.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import {
  MediatorService,
  RequestNotFoundError,
  ReplayNotSupportedError,
} from '../../src/core/mediator.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { RegistryService } from '../../src/core/registry.js'
import { RiskScorer } from '../../src/core/risk-scorer.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'

function seedRow(db: ForemanDb): void {
  db.insert(requests)
    .values({
      id: 'r-original',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      args: JSON.stringify({ path: 'src/auth.ts' }),
      riskScore: 0,
      decision: 'allowed',
      decidedBy: 'policy:1',
      createdAt: Date.now() - 60_000,
      decidedAt: Date.now() - 60_000,
    })
    .run()
}

describe('MediatorService.replay', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let approval: ApprovalService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    approval = {
      request: vi.fn(async () => ({ decision: 'denied' as const })),
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('re-runs the decision pipeline for an existing requestId', async () => {
    const registry = new RegistryService(db, bus)
    const policy = new PolicyEngine(db, bus)
    policy.loadYamlText(`
agents:
  hermes:
    can_call:
      claude-code: [read_file]
`)
    const mediator = new MediatorService({
      registry,
      policy,
      risk: new RiskScorer(db, []),
      approval,
      db,
      bus,
    })
    seedRow(db)
    const result = await mediator.replay('r-original')
    expect(result.decision).toBe('allowed')
    expect(result.requestId).not.toBe('r-original')
  })

  it('throws RequestNotFoundError when the id does not exist', async () => {
    const registry = new RegistryService(db, bus)
    const mediator = new MediatorService({
      registry,
      policy: new PolicyEngine(db, bus),
      risk: new RiskScorer(db, []),
      approval,
      db,
      bus,
    })
    await expect(mediator.replay('ghost')).rejects.toBeInstanceOf(
      RequestNotFoundError,
    )
  })

  it('throws ReplayNotSupportedError when deps.db is missing', async () => {
    const registry = new RegistryService(db, bus)
    const mediator = new MediatorService({
      registry,
      policy: new PolicyEngine(db, bus),
      risk: new RiskScorer(db, []),
      approval,
      bus,
    })
    await expect(mediator.replay('anything')).rejects.toBeInstanceOf(
      ReplayNotSupportedError,
    )
  })
})
