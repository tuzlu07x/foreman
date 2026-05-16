import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ApprovalDecision,
  type ApprovalService,
} from '../../../src/core/approval.js'
import { AuditLogger } from '../../../src/core/audit.js'
import {
  EventBus,
  type ForemanEventMap,
} from '../../../src/core/event-bus.js'
import { MediatorService } from '../../../src/core/mediator.js'
import { PolicyEngine } from '../../../src/core/policy-engine.js'
import { RegistryService } from '../../../src/core/registry.js'
import { RiskScorer } from '../../../src/core/risk-scorer.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { requests } from '../../../src/db/schema.js'
import { renderRequestDetail } from '../../../src/cli/render.js'

describe('network-patterns end-to-end (#227 acceptance criterion)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let audit: AuditLogger
  let mediator: MediatorService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    audit = new AuditLogger(db, bus)
    const registry = new RegistryService(db, bus)
    const policy = new PolicyEngine(db, bus)
    const risk = new RiskScorer(db, undefined, {
      bucketOverrides: () => policy.getBucketOverrides(),
    })
    const approval: ApprovalService = {
      request: vi.fn(
        async (): Promise<ApprovalDecision> => ({ decision: 'denied' }),
      ),
    }
    mediator = new MediatorService({ registry, policy, risk, approval, bus })
  })

  afterEach(() => {
    audit.dispose()
    sqlite.close()
  })

  it('webhook.site URL in args drives the assessment to high and persists network_exfil_destination', async () => {
    const out = await mediator.handleRequest({
      requestId: 'r-exfil',
      sourceAgent: 'hermes',
      targetAgent: 'sandbox',
      targetTool: 'fetch',
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'fetch',
          arguments: { url: 'https://webhook.site/abc-123', method: 'POST' },
        },
      } as never,
    })

    // 60 exfil + 20 first agent-to-agent = 80 → high
    expect(out.riskBucket).toBe('high')
    expect(out.riskScore).toBe(80)

    audit.flush()
    const row = db
      .select()
      .from(requests)
      .all()
      .find((r) => r.id === 'r-exfil')!
    expect(row.riskBucket).toBe('high')
    const factors = JSON.parse(row.riskFactors!) as Array<{
      rule: string
      points: number
    }>
    expect(factors.some((f) => f.rule === 'network_exfil_destination')).toBe(true)
  })

  it('Anthropic API call alone produces zero network factors', async () => {
    const out = await mediator.handleRequest({
      requestId: 'r-safe',
      sourceAgent: 'hermes',
      targetAgent: 'sandbox',
      targetTool: 'fetch',
      message: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'fetch',
          arguments: { url: 'https://api.anthropic.com/v1/messages' },
        },
      } as never,
    })
    // Only structural first_agent_to_agent (+20) fires → low bucket (0–29)
    expect(out.riskBucket).toBe('low')

    audit.flush()
    const row = db
      .select()
      .from(requests)
      .all()
      .find((r) => r.id === 'r-safe')!
    const factors = JSON.parse(row.riskFactors ?? '[]') as Array<{
      rule: string
      category: string
    }>
    expect(factors.filter((f) => f.category === 'network')).toEqual([])
  })

  it('mixed call (safe + exfil) gets safe-list discount in the row', async () => {
    await mediator.handleRequest({
      requestId: 'r-mixed',
      sourceAgent: 'hermes',
      targetAgent: 'sandbox',
      targetTool: 'fetch',
      message: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'fetch',
          arguments: {
            urls: [
              'https://api.anthropic.com/v1/messages',
              'https://webhook.site/leak',
            ],
          },
        },
      } as never,
    })
    audit.flush()
    const row = db
      .select()
      .from(requests)
      .all()
      .find((r) => r.id === 'r-mixed')!
    const factors = JSON.parse(row.riskFactors!) as Array<{
      rule: string
      points: number
    }>
    const exfil = factors.find((f) => f.rule === 'network_exfil_destination')!
    const safe = factors.find((f) => f.rule === 'network_safe_host')!
    expect(exfil.points).toBe(60)
    expect(safe.points).toBe(-15)
  })

  it('IP-literal URL renders cleanly through foreman log show', async () => {
    await mediator.handleRequest({
      requestId: 'r-ip',
      sourceAgent: 'hermes',
      targetAgent: 'sandbox',
      targetTool: 'fetch',
      message: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'fetch',
          arguments: { url: 'http://169.254.169.254/latest/meta-data/' },
        },
      } as never,
    })
    audit.flush()
    const row = db
      .select()
      .from(requests)
      .all()
      .find((r) => r.id === 'r-ip')!
    const detail = renderRequestDetail(row).replace(/\x1b\[[0-9;]*m/g, '')
    expect(detail).toContain('network_ip_literal')
    expect(detail).toContain('lateral movement')
  })
})
