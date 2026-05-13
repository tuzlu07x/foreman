import { describe, expect, it, vi } from 'vitest'
import {
  EventBus,
  bus,
  type ForemanEventMap,
} from '../../src/core/event-bus.js'

describe('EventBus', () => {
  it('delivers a typed payload to subscribers', () => {
    const local = new EventBus<ForemanEventMap>()
    const handler = vi.fn()
    local.on('agent:registered', handler)
    local.emit('agent:registered', {
      agentId: 'hermes',
      displayName: 'Hermes',
      transport: 'stdio',
      registeredAt: 123,
    })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      agentId: 'hermes',
      displayName: 'Hermes',
      transport: 'stdio',
      registeredAt: 123,
    })
  })

  it('unsubscribes via the returned function', () => {
    const local = new EventBus<ForemanEventMap>()
    const handler = vi.fn()
    const off = local.on('session:halted', handler)
    off()
    local.emit('session:halted', {
      sessionId: 's1',
      reason: 'turn_limit',
      turnCount: 6,
      tokenCount: 0,
      haltedAt: 1,
    })
    expect(handler).not.toHaveBeenCalled()
    expect(local.listenerCount('session:halted')).toBe(0)
  })

  it('once() fires exactly once', () => {
    const local = new EventBus<ForemanEventMap>()
    const handler = vi.fn()
    local.once('approval:resolved', handler)
    local.emit('approval:resolved', {
      requestId: 'r1',
      decision: 'allowed',
      resolvedBy: 'user',
    })
    local.emit('approval:resolved', {
      requestId: 'r2',
      decision: 'denied',
      resolvedBy: 'timeout',
    })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('isolates subscriptions across separate buses', () => {
    const a = new EventBus<ForemanEventMap>()
    const b = new EventBus<ForemanEventMap>()
    const handler = vi.fn()
    a.on('policy:changed', handler)
    b.emit('policy:changed', {
      ruleId: 1,
      sourceAgent: '*',
      target: 'tool:shell_exec',
      effect: 'deny',
      createdBy: 'user',
      changedAt: 0,
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not throw when emitting with no listeners', () => {
    const local = new EventBus<ForemanEventMap>()
    expect(() =>
      local.emit('agent:heartbeat', {
        agentId: 'x',
        status: 'active',
        seenAt: 0,
      }),
    ).not.toThrow()
  })

  it('removeAllListeners clears only the specified event', () => {
    const local = new EventBus<ForemanEventMap>()
    local.on('request:received', () => {})
    local.on('request:decided', () => {})
    local.removeAllListeners('request:received')
    expect(local.listenerCount('request:received')).toBe(0)
    expect(local.listenerCount('request:decided')).toBe(1)
  })

  it('exports a working singleton bus', () => {
    const handler = vi.fn()
    const off = bus.on('agent:heartbeat', handler)
    bus.emit('agent:heartbeat', {
      agentId: 'claude-code',
      status: 'active',
      seenAt: 42,
    })
    off()
    expect(handler).toHaveBeenCalledOnce()
  })
})
