import { describe, expect, it } from 'vitest'
import { LlmProviderError } from '../../../src/core/llm/client.js'
import {
  ChatgptPlanLlmClient,
  parseResponsesStream,
  type ChatgptPlanFetch,
  type ChatgptPlanFetchResponse,
} from '../../../src/core/llm/providers/chatgpt-plan.js'

// OpenAI's rules for ChatGPT plan use in open-source apps
// (developers.openai.com/siwc/token-sharing-open-source/models-and-inference):
// the public Responses API, `store: false`, `stream: true`, and none of the
// fields it refuses.

interface MockResp {
  status?: number
  textBody?: string
  events?: string[]
}

function makeSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(ev))
      controller.close()
    },
  })
}

function makeFetch(plan: MockResp[]): {
  fetchImpl: ChatgptPlanFetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  let cursor = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: ChatgptPlanFetch = async (url, init) => {
    calls.push({ url, init })
    const next = plan[cursor++] ?? { status: 200, events: [] }
    const status = next.status ?? 200
    const res: ChatgptPlanFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      text: async () => next.textBody ?? '',
      body: next.events ? makeSseStream(next.events) : null,
    }
    return res
  }
  return { fetchImpl, calls }
}

/** SSE event helpers — each must end in `\n\n` to terminate the event. */
const sseDelta = (text: string): string =>
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`

const sseCompleted = (
  input: number,
  output: number,
  cached = 0,
): string =>
  `data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: input,
        output_tokens: output,
        ...(cached > 0 ? { input_tokens_details: { cached_tokens: cached } } : {}),
      },
    },
  })}\n\n`

function tokenProvider(accessToken: string): () => Promise<{ accessToken: string }> {
  return async () => ({ accessToken })
}

describe('ChatgptPlanLlmClient — request shape', () => {
  it('POSTs to the public Responses API, never ChatGPT\'s backend-api', async () => {
    const f = makeFetch([
      { events: [sseDelta('hi'), sseCompleted(10, 2)] },
    ])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await client.call('say hi', { feature: 'test', maxTokens: 16 })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/responses')
  })

  it('sends the bearer token and presents itself as nothing else', async () => {
    const f = makeFetch([{ events: [sseCompleted(0, 0)] }])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 16 })
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer TOK')
    expect(headers['accept']).toBe('text/event-stream')
    expect(headers['content-type']).toBe('application/json')
    expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization', 'content-type'])
  })

  it('body has store=false, dotted model, Responses input shape', async () => {
    const f = makeFetch([{ events: [sseCompleted(0, 0)] }])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hello world', { feature: 'test', maxTokens: 16 })
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<
      string,
      unknown
    >
    expect(body.model).toBe('gpt-5.4')
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    for (const refused of ['max_output_tokens', 'temperature', 'top_p', 'metadata', 'user']) {
      expect(body).not.toHaveProperty(refused)
    }
    expect(body.instructions).toBe('You are a helpful assistant.')
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello world' }],
      },
    ])
  })
})

describe('ChatgptPlanLlmClient — response parsing', () => {
  it('extracts text from concatenated output_text.delta events', async () => {
    const f = makeFetch([
      {
        events: [sseDelta('Hel'), sseDelta('lo '), sseDelta('there!'), sseCompleted(10, 3)],
      },
    ])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.text).toBe('Hello there!')
    expect(res.outputTokens).toBe(3)
  })

  it('subtracts cached tokens from input_tokens for cost accounting', async () => {
    const f = makeFetch([
      { events: [sseDelta('ok'), sseCompleted(100, 5, 30)] },
    ])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.inputTokens).toBe(70) // 100 - 30 cached
    expect(res.outputTokens).toBe(5)
    expect(res.cacheHit).toBe(true)
  })

  it('reports costUsd = 0 (ChatGPT subscription, not API budget)', async () => {
    const f = makeFetch([
      { events: [sseDelta('hi'), sseCompleted(50, 10)] },
    ])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.costUsd).toBe(0)
  })

  it('handles a buffered chunk that splits an event mid-line', async () => {
    const f = makeFetch([
      {
        // The transport may deliver events across arbitrary chunk
        // boundaries — verify the parser stitches them back together.
        events: [
          'data: {"type":"response.output_text.delta",',
          '"delta":"split!"}\n\n',
          sseCompleted(1, 1),
        ],
      },
    ])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.text).toBe('split!')
  })

  it('ignores [DONE] sentinels and unknown event types', async () => {
    const f = makeFetch([
      {
        events: [
          'data: [DONE]\n\n',
          'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking..."}\n\n',
          sseDelta('answer'),
          sseCompleted(1, 1),
        ],
      },
    ])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.text).toBe('answer')
  })
})

describe('ChatgptPlanLlmClient — errors', () => {
  const failing = (status: number, code: string): MockResp => ({
    status,
    textBody: JSON.stringify({ error: { code, message: 'no' } }),
  })
  const client = (f: ReturnType<typeof makeFetch>, wait: (ms: number) => Promise<void> = async () => undefined) =>
    new ChatgptPlanLlmClient({ tokenProvider: tokenProvider('TOK'), model: 'gpt-5.4', fetchImpl: f.fetchImpl, wait })
  const ask = { feature: 'test', maxTokens: 16 } as const

  it('sends you to ChatGPT usage settings at the plan limit, without retrying', async () => {
    const f = makeFetch([failing(429, 'subscription_sharing_usage_limit_exceeded')])
    await expect(client(f).call('hi', ask)).rejects.toThrow(/chatgpt\.com\/settings\/usage/)
    expect(f.calls).toHaveLength(1)
  })

  it('stops on an ineligible plan and suggests an API key', async () => {
    const f = makeFetch([failing(403, 'subscription_sharing_user_not_eligible')])
    await expect(client(f).call('hi', ask)).rejects.toThrow(/API key/)
    expect(f.calls).toHaveLength(1)
  })

  it('asks you to sign in again on a 401', async () => {
    const f = makeFetch([{ status: 401, textBody: '{"detail":"no"}' }])
    await expect(client(f).call('hi', ask)).rejects.toThrow(/foreman llm login openai/)
  })

  it('retries a passing outage a bounded number of times', async () => {
    const waits: number[] = []
    const f = makeFetch([failing(503, 'subscription_sharing_usage_unavailable'), failing(503, 'subscription_sharing_usage_unavailable'), { events: [sseDelta('ok'), sseCompleted(1, 1)] }])
    const out = await client(f, async (ms) => void waits.push(ms)).call('hi', ask)
    expect(out.text).toBe('ok')
    expect(waits).toEqual([1000, 2000])
  })

  it('gives up after that', async () => {
    const f = makeFetch([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }])
    await expect(client(f).call('hi', ask)).rejects.toThrow(/unavailable/)
    expect(f.calls).toHaveLength(3)
  })

  it('does not count a stream as an answer until response.completed', async () => {
    const f = makeFetch([{ events: [sseDelta('half an ans')] }])
    await expect(client(f).call('hi', ask)).rejects.toThrow(/ended before/)
  })

  it('treats response.incomplete as a failure', async () => {
    const f = makeFetch([{ events: [sseDelta('half'), `data: ${JSON.stringify({ type: 'response.incomplete' })}\n\n`] }])
    await expect(client(f).call('hi', ask)).rejects.toThrow(/incomplete/)
  })

  it('throws LlmProviderError on a generic non-2xx', async () => {
    const f = makeFetch([{ status: 500, textBody: 'kaboom' }])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 16 }),
    ).rejects.toThrow(LlmProviderError)
  })

  it('throws LlmProviderError when the stream surfaces a response.failed event', async () => {
    const f = makeFetch([
      {
        events: [
          sseDelta('partial'),
          `data: ${JSON.stringify({ type: 'response.failed', error: { message: 'model timed out' } })}\n\n`,
        ],
      },
    ])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 16 }),
    ).rejects.toThrow(/model timed out/)
  })
})

describe('parseResponsesStream — direct', () => {
  it('returns text + usage from a small stream', async () => {
    const stream = makeSseStream([
      sseDelta('AB'),
      sseDelta('C'),
      sseCompleted(20, 4, 5),
    ])
    const out = await parseResponsesStream(stream)
    expect(out.text).toBe('ABC')
    expect(out.usage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cachedTokens: 5,
    })
  })

  it('returns zero usage when response.completed carries none', async () => {
    const stream = makeSseStream([`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`, 'data: [DONE]\n\n'])
    const out = await parseResponsesStream(stream)
    expect(out.text).toBe('')
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 })
  })
})

describe('ChatgptPlanLlmClient — identity', () => {
  it('providerId is the literal "openai" (same logical provider as API-key)', async () => {
    const f = makeFetch([{ events: [sseCompleted(0, 0)] }])
    const client = new ChatgptPlanLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    expect(client.providerId).toBe('openai')
    expect(client.model).toBe('gpt-5.4')
  })
})
