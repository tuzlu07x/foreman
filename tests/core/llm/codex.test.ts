import { describe, expect, it } from 'vitest'
import { LlmProviderError } from '../../../src/core/llm/client.js'
import {
  CodexLlmClient,
  parseCodexSseStream,
  type CodexFetch,
  type CodexFetchResponse,
} from '../../../src/core/llm/providers/codex.js'

// =============================================================================
// Codex (ChatGPT backend Responses API) client — Faz 3 / #506
//
// Pins the wire-shape contract pi-ai / Hermes proved: POST to
// chatgpt.com/backend-api/codex/responses, Bearer + chatgpt-account-id +
// originator headers, body with `store: false` and the Responses `input[]`
// shape, SSE response stream with `response.output_text.delta` chunks and a
// `response.completed` event carrying usage.
// =============================================================================

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
  fetchImpl: CodexFetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  let cursor = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: CodexFetch = async (url, init) => {
    calls.push({ url, init })
    const next = plan[cursor++] ?? { status: 200, events: [] }
    const status = next.status ?? 200
    const res: CodexFetchResponse = {
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

function tokenProvider(
  accessToken: string,
  accountId = 'acc-1',
): () => Promise<{ accessToken: string; accountId: string }> {
  return async () => ({ accessToken, accountId })
}

describe('CodexLlmClient — request shape', () => {
  it('POSTs to chatgpt.com/backend-api/codex/responses', async () => {
    const f = makeFetch([
      { events: [sseDelta('hi'), sseCompleted(10, 2)] },
    ])
    const client = new CodexLlmClient({
      tokenProvider: tokenProvider('TOK', 'acc-42'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await client.call('say hi', { feature: 'test', maxTokens: 16 })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    )
  })

  it('sends Bearer + chatgpt-account-id + originator + OpenAI-Beta headers', async () => {
    const f = makeFetch([{ events: [sseCompleted(0, 0)] }])
    const client = new CodexLlmClient({
      tokenProvider: tokenProvider('TOK', 'acc-42'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await client.call('hi', { feature: 'test', maxTokens: 16 })
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer TOK')
    expect(headers['chatgpt-account-id']).toBe('acc-42')
    expect(headers['originator']).toBe('codex_cli_rs')
    expect(headers['OpenAI-Beta']).toBe('responses=experimental')
    expect(headers['accept']).toBe('text/event-stream')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['session_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(headers['x-client-request-id']).toBe(headers['session_id'])
  })

  it('body has store=false, dotted model, Responses input shape', async () => {
    const f = makeFetch([{ events: [sseCompleted(0, 0)] }])
    const client = new CodexLlmClient({
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
    expect(body.instructions).toBe('You are a helpful assistant.')
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello world' }],
      },
    ])
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(typeof body.prompt_cache_key).toBe('string')
  })
})

describe('CodexLlmClient — response parsing', () => {
  it('extracts text from concatenated output_text.delta events', async () => {
    const f = makeFetch([
      {
        events: [sseDelta('Hel'), sseDelta('lo '), sseDelta('there!'), sseCompleted(10, 3)],
      },
    ])
    const client = new CodexLlmClient({
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
    const client = new CodexLlmClient({
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
    const client = new CodexLlmClient({
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
    const client = new CodexLlmClient({
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
    const client = new CodexLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    const res = await client.call('hi', { feature: 'test', maxTokens: 16 })
    expect(res.text).toBe('answer')
  })
})

describe('CodexLlmClient — errors', () => {
  it('throws a friendly error when the OAuth token has no accountId', async () => {
    // Token provider that omits accountId entirely — pi-ai keeps it optional
    // so we have to guard against the case explicitly.
    const noAccount: () => Promise<{ accessToken: string }> = async () => ({
      accessToken: 'TOK',
    })
    const client = new CodexLlmClient({
      tokenProvider: noAccount as never,
      model: 'gpt-5.4',
      fetchImpl: makeFetch([]).fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 16 }),
    ).rejects.toThrow(/account id/i)
  })

  it('surfaces a "usage limit" message on HTTP 429', async () => {
    const f = makeFetch([
      {
        status: 429,
        textBody: JSON.stringify({
          error: { code: 'rate_limit_exceeded', message: 'too many' },
        }),
      },
    ])
    const client = new CodexLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 16 }),
    ).rejects.toThrow(/usage limit/i)
  })

  it('surfaces a "usage limit" message when body says usage_limit_reached', async () => {
    const f = makeFetch([
      {
        status: 403,
        textBody: JSON.stringify({
          error: { code: 'usage_limit_reached', plan_type: 'pro' },
        }),
      },
    ])
    const client = new CodexLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 16 }),
    ).rejects.toThrow(/usage limit/i)
  })

  it('throws LlmProviderError on a generic non-2xx', async () => {
    const f = makeFetch([{ status: 500, textBody: 'kaboom' }])
    const client = new CodexLlmClient({
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
    const client = new CodexLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    await expect(
      client.call('hi', { feature: 'test', maxTokens: 16 }),
    ).rejects.toThrow(/model timed out/)
  })
})

describe('parseCodexSseStream — direct', () => {
  it('returns text + usage from a small stream', async () => {
    const stream = makeSseStream([
      sseDelta('AB'),
      sseDelta('C'),
      sseCompleted(20, 4, 5),
    ])
    const out = await parseCodexSseStream(stream)
    expect(out.text).toBe('ABC')
    expect(out.usage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cachedTokens: 5,
    })
  })

  it('returns empty text + zero usage when the stream has no usable events', async () => {
    const stream = makeSseStream(['data: [DONE]\n\n'])
    const out = await parseCodexSseStream(stream)
    expect(out.text).toBe('')
    expect(out.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    })
  })
})

describe('CodexLlmClient — identity', () => {
  it('providerId is the literal "openai" (same logical provider as API-key)', async () => {
    const f = makeFetch([{ events: [sseCompleted(0, 0)] }])
    const client = new CodexLlmClient({
      tokenProvider: tokenProvider('TOK'),
      model: 'gpt-5.4',
      fetchImpl: f.fetchImpl,
    })
    expect(client.providerId).toBe('openai')
    expect(client.model).toBe('gpt-5.4')
  })
})
