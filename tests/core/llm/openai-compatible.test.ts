import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LlmProviderError } from '../../../src/core/llm/client.js'
import { LlmConfigSchema } from '../../../src/core/llm/config.js'
import { buildLlmClient } from '../../../src/core/llm/factory.js'
import {
  clearModelsDiscoveryCache,
  discoverModels,
  ModelDiscoveryError,
} from '../../../src/core/llm/models-discovery.js'
import {
  calculateCostUsd,
  OpenAICompatibleLlmClient,
} from '../../../src/core/llm/providers/openai-compatible.js'
import { SecretNotFoundError } from '../../../src/core/secret-store.js'
import {
  classifyBrainDiscoveryError,
  selfHostedTarget,
} from '../../../src/tui/setup-wizard/foreman-llm-logic.js'

// =============================================================================
// Ollama / OpenAI-compatible brain client and model discovery, against a
// fake HTTP server on 127.0.0.1 (random port). Nothing here reaches the
// network or a real Ollama. The API key is an obvious fake.
// =============================================================================

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void

interface Hit {
  method: string
  url: string
  authorization: string | undefined
  body: string
}

let server: Server
let base: string
let handler: Handler
let hits: Hit[] = []
const openSockets = new Set<import('node:net').Socket>()

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function completion(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): unknown {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf-8')))
    req.on('end', () => {
      hits.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      })
      handler(req, body, res)
    })
  })
  server.on('connection', (s) => {
    openSockets.add(s)
    s.on('close', () => openSockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => {
  hits = []
  clearModelsDiscoveryCache()
})

afterAll(async () => {
  for (const s of openSockets) s.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const FAKE_KEY = 'fake-compat-key-000'

function client(
  providerId: 'ollama' | 'openai_compatible',
  opts: { apiKey?: string | null; model?: string; baseUrl?: string } = {},
): OpenAICompatibleLlmClient {
  return new OpenAICompatibleLlmClient({
    providerId,
    baseUrl: opts.baseUrl ?? `${base}/v1`,
    model: opts.model ?? 'test-model',
    apiKey: opts.apiKey ?? null,
  })
}

async function providerError(p: Promise<unknown>): Promise<LlmProviderError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(LlmProviderError)
    return err as LlmProviderError
  }
  throw new Error('expected a rejection')
}

describe('OpenAICompatibleLlmClient — chat completions', () => {
  it('sends a keyless Ollama request in the Chat Completions shape and bills $0', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, completion('pong', { prompt_tokens: 12, completion_tokens: 3 }))
    const res = await client('ollama', { model: 'llama3.2:3b' }).call('hello', {
      feature: 'verification',
      maxTokens: 64,
      temperature: 0,
    })
    expect(res).toMatchObject({ text: 'pong', inputTokens: 12, outputTokens: 3, costUsd: 0, cacheHit: false })
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.method).toBe('POST')
    expect(hits[0]!.url).toBe('/v1/chat/completions')
    expect(hits[0]!.authorization).toBeUndefined()
    expect(JSON.parse(hits[0]!.body)).toEqual({
      model: 'llama3.2:3b',
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    })
  })

  it('sends the API key as a Bearer token and bills a paid endpoint at the ceiling price', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, completion('ok', { prompt_tokens: 1000, completion_tokens: 200 }))
    const res = await client('openai_compatible', { apiKey: FAKE_KEY, model: 'deepseek-chat' }).call('x', {
      feature: 'verification',
      maxTokens: 300,
    })
    expect(hits[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`)
    // $10 / $50 per MTok — the most expensive current price Foreman knows.
    expect(res.costUsd).toBeCloseTo((1000 * 10 + 200 * 50) / 1_000_000, 10)
  })

  it('bills the worst case when a paid endpoint sends no usage block', async () => {
    handler = (_req, _body, res) => json(res, 200, completion('ok'))
    const prompt = 'p'.repeat(400)
    const res = await client('openai_compatible', { apiKey: FAKE_KEY }).call(prompt, {
      feature: 'verification',
      maxTokens: 100,
    })
    expect(res.inputTokens).toBe(0)
    expect(res.outputTokens).toBe(0)
    expect(res.costUsd).toBeCloseTo((400 * 10 + 100 * 50) / 1_000_000, 10)
  })

  it('ping() makes the cheapest round-trip', async () => {
    handler = (_req, _body, res) => json(res, 200, completion('pong', { prompt_tokens: 5, completion_tokens: 1 }))
    const res = await client('ollama').ping()
    expect(res.text).toBe('pong')
    expect(JSON.parse(hits[0]!.body).max_tokens).toBe(8)
  })

  it('surfaces a 401 as LlmProviderError without echoing the key', async () => {
    handler = (_req, _body, res) => json(res, 401, { error: { message: 'invalid api key' } })
    const err = await providerError(
      client('openai_compatible', { apiKey: FAKE_KEY }).call('x', { feature: 't', maxTokens: 8 }),
    )
    expect(err.providerId).toBe('openai_compatible')
    expect(err.message).toMatch(/^OpenAI-compatible endpoint HTTP 401: /)
    expect(err.message).not.toContain(FAKE_KEY)
  })

  it('surfaces a 500 as LlmProviderError', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(500)
      res.end('model runner crashed')
    }
    const err = await providerError(client('ollama').call('x', { feature: 't', maxTokens: 8 }))
    expect(err.providerId).toBe('ollama')
    expect(err.message).toBe('Ollama HTTP 500: model runner crashed')
  })

  it('surfaces an error object in a 200 body', async () => {
    handler = (_req, _body, res) => json(res, 200, { error: { message: 'model "nope" not found' } })
    const err = await providerError(client('ollama').call('x', { feature: 't', maxTokens: 8 }))
    expect(err.message).toBe('Ollama error: model "nope" not found')
  })

  it('rejects a body that is not JSON', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices": [')
    }
    const err = await providerError(client('ollama').call('x', { feature: 't', maxTokens: 8 }))
    expect(err.message).toBe('Ollama returned a response that is not JSON')
  })

  it('times out when the server never answers', async () => {
    handler = () => {
      /* never respond */
    }
    const err = await providerError(
      client('ollama').call('x', { feature: 't', maxTokens: 8, timeoutMs: 150 }),
    )
    expect(err.message).toBe('Ollama fetch failed: timed out after 150ms')
  })

  it('times out when the server sends headers and then stalls the body', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"choices":')
    }
    const err = await providerError(
      client('ollama').call('x', { feature: 't', maxTokens: 8, timeoutMs: 150 }),
    )
    expect(err.message).toMatch(/timed out after 150ms/)
  })

  it('refuses redirects, so the prompt and key never reach another host', async () => {
    handler = (req, _body, res) => {
      if (req.url === '/elsewhere/chat/completions') {
        json(res, 200, completion('should not get here'))
        return
      }
      res.writeHead(307, { location: `${base}/elsewhere/chat/completions` })
      res.end()
    }
    await providerError(
      client('openai_compatible', { apiKey: FAKE_KEY }).call('secret prompt', { feature: 't', maxTokens: 8 }),
    )
    expect(hits.map((h) => h.url)).toEqual(['/v1/chat/completions'])
  })

  it('reports a refused connection as LlmProviderError', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const err = await providerError(
      client('ollama', { baseUrl: `http://127.0.0.1:${port}/v1` }).call('x', { feature: 't', maxTokens: 8 }),
    )
    expect(err.message).toMatch(/^Ollama fetch failed: /)
  })
})

describe('calculateCostUsd (openai_compatible)', () => {
  const cost = (model: string): number => calculateCostUsd(model, 1_000_000, 1_000_000)

  it('bills an unpriced model at the ceiling', () => {
    expect(cost('deepseek-chat')).toBe(10 + 50)
    expect(cost('meta-llama/Llama-3.1-8B-Instruct-Turbo')).toBe(10 + 50)
  })

  it('bills a -pro model at the pro ceiling', () => {
    expect(cost('some-vendor/model-x-pro')).toBe(30 + 180)
  })

  it('never goes under a known model that costs more than the ceiling', () => {
    // o1-pro is $150 / $600 at OpenAI; OpenRouter names it openai/o1-pro.
    expect(cost('openai/o1-pro')).toBe(150 + 600)
  })

  it('does not bill a cheap known model below the ceiling', () => {
    expect(cost('openai/gpt-6-luna')).toBe(10 + 50)
    expect(cost('anthropic/claude-haiku-4-5')).toBe(10 + 50)
  })
})

describe('buildLlmClient → fake server', () => {
  const emptyStore = {
    get(name: string): string {
      throw new SecretNotFoundError(name)
    },
  }

  it('an Ollama brain configured with a base URL talks to <base>/v1/chat/completions', async () => {
    handler = (_req, _body, res) => json(res, 200, completion('{"ok":true}', { prompt_tokens: 1, completion_tokens: 1 }))
    const config = LlmConfigSchema.parse({
      provider: 'ollama',
      model: 'qwen2.5:3b',
      credentials: { ollama: { endpoint: base } },
    })
    const res = await buildLlmClient(config, emptyStore as never).call('x', { feature: 't', maxTokens: 8 })
    expect(res.text).toBe('{"ok":true}')
    expect(hits[0]!.url).toBe('/v1/chat/completions')
  })

  it('an openai_compatible brain posts to <base>/chat/completions with its stored key', async () => {
    handler = (_req, _body, res) => json(res, 200, completion('fine', { prompt_tokens: 1, completion_tokens: 1 }))
    const config = LlmConfigSchema.parse({
      provider: 'openai_compatible',
      model: 'm',
      credentials: {
        openai_compatible: { endpoint_secret: 'compat-endpoint', key_secret: 'compat-key' },
      },
    })
    const store = {
      get(name: string): string {
        if (name === 'compat-endpoint') return `${base}/api/v1`
        if (name === 'compat-key') return FAKE_KEY
        throw new SecretNotFoundError(name)
      },
    }
    await buildLlmClient(config, store as never).call('x', { feature: 't', maxTokens: 8 })
    expect(hits[0]!.url).toBe('/api/v1/chat/completions')
    expect(hits[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`)
  })
})

describe('model discovery for self-hosted brains', () => {
  it('lists pulled Ollama models from /api/tags, without embedding models', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, {
        models: [
          { name: 'qwen2.5:7b' },
          { name: 'nomic-embed-text:latest' },
          { name: 'llama3.2:3b' },
        ],
      })
    // A base URL given with the /v1 suffix still reaches the native API.
    const models = await discoverModels('ollama', { apiKey: '', baseUrl: `${base}/v1` })
    expect(models.map((m) => m.id)).toEqual(['llama3.2:3b', 'qwen2.5:7b'])
    expect(hits[0]!.url).toBe('/api/tags')
    expect(hits[0]!.authorization).toBeUndefined()
  })

  it('lists OpenAI-compatible models from <base>/models with the Bearer key', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, {
        data: [{ id: 'deepseek-reasoner' }, { id: 'text-embedding-3-small' }, { id: 'deepseek-chat' }],
      })
    const models = await discoverModels('openai_compatible', { apiKey: FAKE_KEY, baseUrl: `${base}/v1` })
    expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(hits[0]!.url).toBe('/v1/models')
    expect(hits[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`)
  })

  it('caches per base URL, not just per key', async () => {
    handler = (req, _body, res) => json(res, 200, { data: [{ id: `model-at-${req.url}` }] })
    const a = await discoverModels('openai_compatible', { apiKey: '', baseUrl: `${base}/a` })
    const b = await discoverModels('openai_compatible', { apiKey: '', baseUrl: `${base}/b` })
    expect(a[0]!.id).toBe('model-at-/a/models')
    expect(b[0]!.id).toBe('model-at-/b/models')
  })

  it('needs a valid http(s) base URL', async () => {
    await expect(discoverModels('ollama', { apiKey: '' })).rejects.toThrow(ModelDiscoveryError)
    await expect(
      discoverModels('openai_compatible', { apiKey: '', baseUrl: 'file:///etc' }),
    ).rejects.toThrow(/Invalid base URL/)
    expect(hits).toHaveLength(0)
  })

  it('turns a 401 into "rejected the API key"', async () => {
    handler = (_req, _body, res) => json(res, 401, { error: 'no' })
    const target = selfHostedTarget('custom', `${base}/v1`, null)
    const err = await discoverModels('openai_compatible', { apiKey: FAKE_KEY, baseUrl: target.baseUrl }).catch(
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(ModelDiscoveryError)
    expect(classifyBrainDiscoveryError((err as Error).message, target)).toBe(
      'your endpoint rejected the API key (HTTP 401). Press [Esc] to re-enter it.',
    )
  })

  it('turns a 500 into a "server error" hint', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(500)
      res.end('boom')
    }
    const target = selfHostedTarget('ollama', base, null)
    const err = (await discoverModels('ollama', { apiKey: '', baseUrl: base }).catch((e: unknown) => e)) as Error
    expect(classifyBrainDiscoveryError(err.message, target)).toMatch(/returned a server error \(HTTP 500\)/)
  })

  it('turns malformed JSON into a wrong-base-URL hint', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not an API</html>')
    }
    const target = selfHostedTarget('custom', base, null)
    const err = (await discoverModels('openai_compatible', { apiKey: '', baseUrl: base }).catch(
      (e: unknown) => e,
    )) as Error
    expect(err).toBeInstanceOf(ModelDiscoveryError)
    expect(classifyBrainDiscoveryError(err.message, target)).toMatch(/usually ends in \/v1/)
    // A base that already ends in /v1 just has no list: say that instead.
    expect(classifyBrainDiscoveryError(err.message, selfHostedTarget('custom', `${base}/v1`, null))).toBe(
      `${base}/v1 answered, but has no model list at /models.`,
    )
  })

  it('turns a refused connection into "start it with ollama serve"', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const err = (await discoverModels('ollama', { apiKey: '', baseUrl: url }).catch((e: unknown) => e)) as Error
    expect(classifyBrainDiscoveryError(err.message, selfHostedTarget('ollama', url, null))).toBe(
      `Couldn't reach Ollama at ${url} — start it with \`ollama serve\`, or press [Esc] to change the URL.`,
    )
  })

  it('gives up after the timeout', async () => {
    handler = () => {
      /* never respond */
    }
    const err = (await discoverModels('ollama', { apiKey: '', baseUrl: base, timeoutMs: 100 }).catch(
      (e: unknown) => e,
    )) as Error
    expect(classifyBrainDiscoveryError(err.message, selfHostedTarget('ollama', base, null))).toMatch(
      /Couldn't reach Ollama/,
    )
  })
})
