import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  WebhookChannel,
  WebhookDeliveryError,
  webhookUrlProblem,
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
    expect(ref.channelMessageId).toMatch(/^webhook:1:notif-1:req-99$/)
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

  it('signs <timestamp>.<body> with X-Foreman-Timestamp so receivers can refuse replays (#656)', async () => {
    const secret = 'super-secret-key-do-not-leak'
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      signingSecret: secret,
      fetchImpl: f.fetchImpl,
      now: () => 1_779_800_000_123,
    })
    await channel.send(makeNotification())
    const headers = f.calls[0]!.init.headers as Record<string, string>
    const signature = headers['x-foreman-signature']
    expect(headers['x-foreman-timestamp']).toBe('1779800000')
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)
    // Receiver-side verification — independent recompute
    const rawBody = String(f.calls[0]!.init.body)
    const expected =
      'sha256=' + createHmac('sha256', secret).update(`1779800000.${rawBody}`).digest('hex')
    expect(signature).toBe(expected)
    // The body alone (the old scheme) no longer verifies: a captured
    // delivery can't be replayed under a fresh timestamp.
    expect(signature).not.toBe('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'))
  })

  it('never echoes the URL (a stored secret) when fetch refuses it (#656)', async () => {
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/t0ps3cret-path',
      fetchImpl: async (url) => {
        throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`)
      },
    })
    const err = await channel.send(makeNotification()).then(
      () => new Error('sent'),
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(WebhookDeliveryError)
    expect(err.message).not.toContain('t0ps3cret')
    expect(err.message).toMatch(/network error/)
  })

  it('does not echo a receiver error body verbatim (#656)', async () => {
    const f = makeFetch([{ status: 404, body: 'no hook at https://hooks.example.com/t0ps3cret-path' }])
    const channel = new WebhookChannel({ url: 'https://hooks.example.com/t0ps3cret-path', fetchImpl: f.fetchImpl })
    const err = await channel.send(makeNotification()).then(
      () => new Error('sent'),
      (e: unknown) => e as Error,
    )
    expect(err.message).toContain('HTTP 404')
    expect(err.message).not.toContain('t0ps3cret')
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

  it('refuses an empty URL, and plain http:// except to this machine (#636)', () => {
    expect(() => new WebhookChannel({ url: '' })).toThrow(WebhookDeliveryError)
    expect(() => new WebhookChannel({ url: 'http://hooks.example.com/x' })).toThrow(/plain http/)
    expect(() => new WebhookChannel({ url: 'ftp://hooks.example.com/x' })).toThrow(/https/)
    expect(webhookUrlProblem('http://127.0.0.1:8080/hook')).toBeNull()
    expect(webhookUrlProblem('http://localhost/hook')).toBeNull()
    expect(webhookUrlProblem('http://[::1]:9/hook')).toBeNull()
    expect(webhookUrlProblem('http://127.evil.example/hook')).not.toBeNull()
    expect(webhookUrlProblem('https://hooks.example.com/x')).toBeNull()
  })

  it('refuses a URL with credentials without repeating them (#656)', () => {
    for (const url of ['http://user:pw@127.0.0.1:9/hook', 'https://user@hooks.example.com/x']) {
      const problem = webhookUrlProblem(url)
      expect(problem).toMatch(/must not include a user name or password/)
      expect(problem).not.toMatch(/user:pw|user@|127\.0|hooks\.example/)
    }
    expect(() => new WebhookChannel({ url: 'http://user:pw@127.0.0.1:9/hook' })).toThrow(/user name or password/)
    expect(webhookUrlProblem('javascript:alert(1)')).toMatch(/must be https/)
  })

  it('listen is a no-op (outbound-only — see file header)', async () => {
    const channel = new WebhookChannel({ url: 'https://x.example' })
    const handler = vi.fn()
    await channel.listen(handler)
    expect(handler).not.toHaveBeenCalled()
    await channel.shutdown()
  })

  it('sends the outcome once, matched to the original approval (#636)', async () => {
    const f = makeFetch([{ status: 200 }, { status: 200 }])
    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/foreman',
      fetchImpl: f.fetchImpl,
      signingSecret: 's3cret',
    })
    const ref = await channel.send(makeNotification())
    // Countdown refreshes are not sent: a webhook can't edit a delivery.
    await channel.updateMessage(ref, 'Waiting · 30s left')
    expect(f.calls).toHaveLength(1)
    await channel.updateMessage(ref, 'Resolved at 14:18', { final: true })
    expect(f.calls).toHaveLength(2)
    const first = JSON.parse(String(f.calls[0]!.init.body))
    const outcome = JSON.parse(String(f.calls[1]!.init.body))
    expect(first.kind).toBe('notification')
    expect(outcome).toMatchObject({
      kind: 'outcome',
      id: 'notif-1',
      requestId: 'req-99',
      inReplyTo: first.messageId,
      body: 'Resolved at 14:18',
      level: 'info',
    })
    const outcomeHeaders = f.calls[1]!.init.headers as Record<string, string>
    const ts = outcomeHeaders['x-foreman-timestamp']
    expect(outcomeHeaders['x-foreman-signature']).toBe(
      `sha256=${createHmac('sha256', 's3cret').update(`${ts}.${String(f.calls[1]!.init.body)}`).digest('hex')}`,
    )
  })

  it('still matches an outcome after a restart (ids travel in the message id)', async () => {
    const f = makeFetch([{ status: 200 }])
    const channel = new WebhookChannel({ url: 'https://hooks.example.com/foreman', fetchImpl: f.fetchImpl })
    await channel.updateMessage({ channelMessageId: 'webhook:7:notif%3A9:req-1' }, 'Denied', { final: true })
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ id: 'notif:9', requestId: 'req-1' })
  })
})
