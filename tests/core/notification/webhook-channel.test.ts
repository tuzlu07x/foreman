import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  WebhookChannel,
  WebhookDeliveryError,
  type WebhookFetch,
} from '../../../src/core/notification/channels/webhook.js'
import type { Notification } from '../../../src/core/notification/types.js'

interface MockResponse {
  status?: number
  body?: string
}

function makeFetch(plan: MockResponse[]): {
  fetchImpl: WebhookFetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  let cursor = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: WebhookFetch = async (url, init) => {
    calls.push({ url, init })
    const next = plan[cursor++] ?? { status: 200 }
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      text: async () => next.body ?? '',
    }
  }
  return { fetchImpl, calls }
}

function makeNotification(
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id: 'notif-1',
    level: 'critical',
    requestId: 'req-99',
    title: 'Hermes wants .env',
    body: 'Phishing attempt — tap to decide.',
    actions: [{ id: 'deny', label: 'Deny' }],
    agentBlocking: true,
    ...overrides,
  }
}

describe('WebhookChannel — send', () => {
  it('POSTs to the configured URL with JSON content-type', async () => {
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
    })
    const ref = await channel.send(makeNotification())
    expect(ref.channelMessageId).toMatch(/^webhook-/)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe('https://hooks.example.com/foreman')
    expect((f.calls[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
  })

  it('payload follows the documented schema', async () => {
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
    })
    await channel.send(makeNotification())
    const body = JSON.parse(String(f.calls[0]!.init.body))
    expect(body.schema).toBe('foreman.notification.v1')
    expect(body.id).toBe('notif-1')
    expect(body.level).toBe('critical')
    expect(body.requestId).toBe('req-99')
    expect(body.title).toBe('Hermes wants .env')
    expect(body.actions).toEqual([{ id: 'deny', label: 'Deny' }])
    expect(typeof body.sentAt).toBe('number')
  })

  it('adds X-Foreman-Signature when signingSecret is set + receiver can verify', async () => {
    const secret = 'super-secret-key-do-not-leak'
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      signingSecret: secret,
      fetchImpl: f.fetchImpl,
    })
    await channel.send(makeNotification())
    const headers = f.calls[0]!.init.headers as Record<string, string>
    const signature = headers['x-foreman-signature']
    expect(signature).toMatch(/^sha256=[0-9a-f]+$/)
    // Receiver-side verification — independent recompute
    const rawBody = String(f.calls[0]!.init.body)
    const expected =
      'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
    expect(signature).toBe(expected)
  })

  it('omits X-Foreman-Signature when no signingSecret', async () => {
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
    })
    await channel.send(makeNotification())
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['x-foreman-signature']).toBeUndefined()
  })

  it('throws WebhookDeliveryError on non-2xx response', async () => {
    const f = makeFetch([{ status: 500, body: 'server error' }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
    })
    await expect(channel.send(makeNotification())).rejects.toThrow(
      WebhookDeliveryError,
    )
  })

  it('uses POST method', async () => {
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
    })
    await channel.send(makeNotification())
    expect(f.calls[0]!.init.method).toBe('POST')
  })

  it('user-agent header identifies foreman', async () => {
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
    })
    await channel.send(makeNotification())
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['user-agent']).toMatch(/^foreman\//)
  })
})

describe('WebhookChannel — isReady + lifecycle', () => {
  it('isReady returns true for a non-empty URL', async () => {
    const channel = new WebhookChannel({ url: 'https://x.example' })
    expect(await channel.isReady()).toBe(true)
  })

  it('isReady returns false for an empty URL', async () => {
    const channel = new WebhookChannel({ url: '' })
    expect(await channel.isReady()).toBe(false)
  })

  it('listen is a no-op (outbound-only — see file header)', async () => {
    const channel = new WebhookChannel({ url: 'https://x.example' })
    const handler = vi.fn()
    await channel.listen(handler)
    expect(handler).not.toHaveBeenCalled()
    await channel.shutdown()
  })

  it('updateMessage sends a fresh follow-up POST', async () => {
    const f = makeFetch([{ status: 200 }, { status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
    })
    await channel.send(makeNotification())
    await channel.updateMessage(
      { channelMessageId: 'webhook-1' },
      'Resolved at 14:18',
    )
    expect(f.calls).toHaveLength(2)
    const body = JSON.parse(String(f.calls[1]!.init.body))
    expect(body.body).toBe('Resolved at 14:18')
    expect(body.level).toBe('info')
  })
})
