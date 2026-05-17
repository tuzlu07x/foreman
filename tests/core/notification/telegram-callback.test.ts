import { describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { BusApprovalService } from '../../../src/core/approval.js'

// =============================================================================
// Tests for #302 — Telegram callback → approval:resolved flow
// =============================================================================
//
// Pins the channel-tagging contract: when a Telegram tap resolves an
// approval, the `via` field rides the bus → BusApprovalService → mediator
// uses it for `decidedBy: user:telegram`. Critical for the audit log to
// distinguish "approved from phone" vs "approved from terminal".

describe('#302 — Telegram callback → ApprovalService.via propagation', () => {
  it('propagates via on approval:resolved when emitted with one', async () => {
    const bus = new EventBus<ForemanEventMap>()
    const svc = new BusApprovalService({ bus, timeoutMs: 1_000 })

    const pending = svc.request({
      requestId: 'req-1',
      sourceAgent: 'hermes',
      targetAgent: null,
      targetTool: 'read_file',
      args: { path: '.env' },
      riskScore: 80,
      riskReasons: ['secret_file_pattern'],
      riskFactors: [],
      riskBucket: 'high',
      llmVerification: null,
      securityReport: null,
    })

    // Simulate a Telegram callback resolution
    bus.emit('approval:resolved', {
      requestId: 'req-1',
      decision: 'denied',
      resolvedBy: 'user',
      via: 'telegram',
    })

    const decision = await pending
    expect(decision.decision).toBe('denied')
    expect(decision.via).toBe('telegram')
  })

  it('leaves via undefined when the resolver did not specify one (back-compat)', async () => {
    const bus = new EventBus<ForemanEventMap>()
    const svc = new BusApprovalService({ bus, timeoutMs: 1_000 })

    const pending = svc.request({
      requestId: 'req-2',
      sourceAgent: 'hermes',
      targetAgent: null,
      targetTool: 'read_file',
      args: {},
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
    })

    bus.emit('approval:resolved', {
      requestId: 'req-2',
      decision: 'allowed',
      resolvedBy: 'user',
      // No via — TUI / legacy resolver
    })

    const decision = await pending
    expect(decision.via).toBeUndefined()
  })

  it('accepts every supported channel id in the via field', async () => {
    const bus = new EventBus<ForemanEventMap>()
    const svc = new BusApprovalService({ bus, timeoutMs: 1_000 })

    for (const via of ['telegram', 'discord', 'slack', 'webhook'] as const) {
      const reqId = `req-${via}`
      const pending = svc.request({
        requestId: reqId,
        sourceAgent: 'hermes',
        targetAgent: null,
        targetTool: 'read_file',
        args: {},
        riskScore: 0,
        riskReasons: [],
        riskFactors: [],
        riskBucket: 'low',
        llmVerification: null,
        securityReport: null,
      })
      bus.emit('approval:resolved', {
        requestId: reqId,
        decision: 'allowed',
        resolvedBy: 'user',
        via,
      })
      const decision = await pending
      expect(decision.via).toBe(via)
    }
  })
})
