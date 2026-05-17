import { describe, expect, it, vi } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import {
  ForemanVoice,
  type ProactiveMessage,
  type ProactiveOutcome,
} from '../../../src/core/notification/foreman-voice.js'
import type {
  NotificationLevel,
  Notification,
} from '../../../src/core/notification/types.js'

// =============================================================================
// Tests for #303 — ForemanVoice scaffolding
// =============================================================================
//
// Pins the public contract:
//   - sendProactive routes to NotificationService.send with the right level
//   - same-type calls within the throttle window are dropped
//   - quiet hours block non-critical, allow critical
//   - bus subscriptions fan out to registered triggers (the hook follow-up
//     PRs plug into) without crashing on handler errors
//   - dispose() unsubscribes cleanly

interface SendCall {
  level: NotificationLevel
  payload: Omit<Notification, 'id'>
}

function fakeService(): {
  service: { send: (level: NotificationLevel, payload: Omit<Notification, 'id'>) => Promise<{ notificationId: string; outcomes: Map<string, unknown> }> }
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  let counter = 0
  return {
    calls,
    service: {
      send: async (level, payload) => {
        calls.push({ level, payload })
        counter += 1
        return { notificationId: `notif-${counter}`, outcomes: new Map() }
      },
    },
  }
}

function basicMessage(
  overrides: Partial<ProactiveMessage> = {},
): ProactiveMessage {
  return {
    type: 'daily_summary',
    urgency: 'info',
    title: 'Daily summary',
    body: 'today: 3 calls allowed, 0 denied',
    ...overrides,
  }
}

describe('ForemanVoice — sendProactive routing', () => {
  it('routes info messages to NotificationService.send with level=info', async () => {
    const { service, calls } = fakeService()
    const bus = new EventBus<ForemanEventMap>()
    const voice = new ForemanVoice({
      service: service as never,
      bus,
    })
    const result = await voice.sendProactive(basicMessage())
    expect(result.status).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.level).toBe('info')
    expect(calls[0]!.payload.title).toBe('Daily summary')
    expect(calls[0]!.payload.agentBlocking).toBe(false)
    expect(calls[0]!.payload.requestId).toBeNull()
  })

  it('maps urgency=warning → level=warning, urgency=critical → level=critical', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
    })
    await voice.sendProactive(
      basicMessage({ type: 'budget_alert', urgency: 'warning' }),
    )
    await voice.sendProactive(
      basicMessage({ type: 'agent_health', urgency: 'critical' }),
    )
    expect(calls[0]!.level).toBe('warning')
    expect(calls[1]!.level).toBe('critical')
  })

  it('passes inline actions through unchanged (#302 / #303 integration)', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
    })
    await voice.sendProactive(
      basicMessage({
        type: 'pattern_detection',
        urgency: 'warning',
        actions: [
          { id: 'allow_always', label: 'Yes, add deny rule', style: 'primary' },
          { id: 'deny', label: 'No, keep asking', style: 'neutral' },
        ],
      }),
    )
    expect(calls[0]!.payload.actions).toHaveLength(2)
    expect(calls[0]!.payload.actions[0]!.id).toBe('allow_always')
  })
})

describe('ForemanVoice — throttling', () => {
  it('drops a second call of the same type within the cooldown window', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
      throttleMs: { daily_summary: 10_000 },
    })
    const first = await voice.sendProactive(basicMessage())
    const second = await voice.sendProactive(basicMessage())
    expect(first.status).toBe('sent')
    expect(second.status).toBe('throttled')
    if (second.status === 'throttled') {
      expect(second.cooldownMsRemaining).toBeGreaterThan(0)
    }
    expect(calls).toHaveLength(1)
  })

  it('different proactive types have independent throttle counters', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
      throttleMs: {
        daily_summary: 10_000,
        budget_alert: 10_000,
      },
    })
    await voice.sendProactive(basicMessage({ type: 'daily_summary' }))
    await voice.sendProactive(
      basicMessage({ type: 'budget_alert', urgency: 'warning' }),
    )
    expect(calls).toHaveLength(2)
  })

  it('releases the throttle after the window elapses (clock injection)', async () => {
    let nowMs = 1_000_000
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
      throttleMs: { daily_summary: 10_000 },
      now: () => new Date(nowMs),
    })
    await voice.sendProactive(basicMessage())
    nowMs += 11_000 // past the window
    const after = await voice.sendProactive(basicMessage())
    expect(after.status).toBe('sent')
    expect(calls).toHaveLength(2)
  })
})

describe('ForemanVoice — quiet hours', () => {
  it('drops info messages inside the quiet-hours window', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
      quietHours: { enabled: true, from: '22:00', to: '08:00' },
      // 02:00 — inside the wrap-around window
      now: () => new Date('2026-05-20T02:00:00'),
    })
    const result = await voice.sendProactive(basicMessage({ urgency: 'info' }))
    expect(result.status).toBe('quiet_hours')
    expect(calls).toHaveLength(0)
  })

  it('still fires critical messages inside the quiet-hours window', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
      quietHours: { enabled: true, from: '22:00', to: '08:00' },
      now: () => new Date('2026-05-20T02:00:00'),
    })
    const result = await voice.sendProactive(
      basicMessage({ urgency: 'critical', type: 'agent_health' }),
    )
    expect(result.status).toBe('sent')
    expect(calls).toHaveLength(1)
  })

  it('non-wrap-around window also works (no false hits)', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
      quietHours: { enabled: true, from: '13:00', to: '14:00' },
      now: () => new Date('2026-05-20T15:00:00'), // outside
    })
    await voice.sendProactive(basicMessage({ urgency: 'info' }))
    expect(calls).toHaveLength(1)
  })

  it('disabled quiet hours = always allow', async () => {
    const { service, calls } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
      quietHours: { enabled: false, from: '22:00', to: '08:00' },
      now: () => new Date('2026-05-20T02:00:00'),
    })
    await voice.sendProactive(basicMessage())
    expect(calls).toHaveLength(1)
  })
})

describe('ForemanVoice — bus subscriptions + triggers', () => {
  it('start() wires bus listeners; registered triggers fire on event', () => {
    const { service } = fakeService()
    const bus = new EventBus<ForemanEventMap>()
    const voice = new ForemanVoice({
      service: service as never,
      bus,
    })
    voice.start()

    const seen: string[] = []
    voice.registerTrigger('request:decided', (e) => {
      seen.push(`decided:${e.requestId}`)
    })

    bus.emit('request:decided', {
      requestId: 'r-1',
      sourceAgent: 'hermes',
      args: {},
      decision: 'allowed',
      decidedBy: 'user',
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: 0,
      decidedAt: 1,
    })

    expect(seen).toEqual(['decided:r-1'])
    voice.dispose()
  })

  it('a throwing trigger does not stop other triggers from firing', () => {
    const { service } = fakeService()
    const bus = new EventBus<ForemanEventMap>()
    const voice = new ForemanVoice({
      service: service as never,
      bus,
    })
    voice.start()

    let secondFired = false
    voice.registerTrigger('request:decided', () => {
      throw new Error('boom')
    })
    voice.registerTrigger('request:decided', () => {
      secondFired = true
    })

    bus.emit('request:decided', {
      requestId: 'r-1',
      sourceAgent: 'hermes',
      args: {},
      decision: 'allowed',
      decidedBy: 'user',
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: 0,
      decidedAt: 1,
    })

    // Trigger fanout is async; give it a microtask to flush
    return Promise.resolve().then(() => {
      expect(secondFired).toBe(true)
      voice.dispose()
    })
  })

  it('dispose() unsubscribes from the bus', () => {
    const { service } = fakeService()
    const bus = new EventBus<ForemanEventMap>()
    const voice = new ForemanVoice({
      service: service as never,
      bus,
    })
    voice.start()
    const trigger = vi.fn()
    voice.registerTrigger('request:decided', trigger)
    voice.dispose()
    bus.emit('request:decided', {
      requestId: 'r-1',
      sourceAgent: 'hermes',
      args: {},
      decision: 'allowed',
      decidedBy: 'user',
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: 0,
      decidedAt: 1,
    })
    expect(trigger).not.toHaveBeenCalled()
  })

  it('start() is idempotent (calling twice does not double-subscribe)', () => {
    const { service } = fakeService()
    const bus = new EventBus<ForemanEventMap>()
    const voice = new ForemanVoice({
      service: service as never,
      bus,
    })
    voice.start()
    voice.start()
    let count = 0
    voice.registerTrigger('request:decided', () => {
      count += 1
    })
    bus.emit('request:decided', {
      requestId: 'r-1',
      sourceAgent: 'hermes',
      args: {},
      decision: 'allowed',
      decidedBy: 'user',
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: 'low',
      llmVerification: null,
      securityReport: null,
      durationMs: 1,
      createdAt: 0,
      decidedAt: 1,
    })
    return Promise.resolve().then(() => {
      expect(count).toBe(1)
      voice.dispose()
    })
  })
})

describe('ForemanVoice — outcome reporting', () => {
  it('returns sent + notificationId on success', async () => {
    const { service } = fakeService()
    const voice = new ForemanVoice({
      service: service as never,
      bus: new EventBus<ForemanEventMap>(),
    })
    const result: ProactiveOutcome = await voice.sendProactive(basicMessage())
    expect(result.status).toBe('sent')
    if (result.status === 'sent') {
      expect(result.notificationId).toMatch(/^notif-/)
    }
  })

  it('returns no_service when the underlying send throws', async () => {
    const voice = new ForemanVoice({
      service: {
        send: async () => {
          throw new Error('all channels down')
        },
      } as never,
      bus: new EventBus<ForemanEventMap>(),
    })
    const result = await voice.sendProactive(basicMessage())
    expect(result.status).toBe('no_service')
  })
})
