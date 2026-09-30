import { createServer, type Server } from 'node:http'
import { waitFor } from './sandbox.js'

// =============================================================================
// A fake Ollama on 127.0.0.1 — Foreman's LLM with no network
// =============================================================================
//
// llm.yaml `provider: ollama` with `credentials.ollama.endpoint` pointed here.
// Foreman's ollama client speaks Ollama's OpenAI-compatible API
// (src/core/llm/providers/openai-compatible.ts): POST <root>/v1/chat/completions
// with one user message holding the whole prompt. The fake records every
// prompt and answers with whatever `answer(prompt)` returns.

export interface LlmCall {
  path: string
  model: string
  prompt: string
  /** What the fake answered. */
  reply: string
  at: number
}

export class FakeOllama {
  readonly calls: LlmCall[] = []

  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  static async start(answer: (prompt: string) => string): Promise<FakeOllama> {
    let fake: FakeOllama | null = null
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const path = (req.url ?? '/').split('?')[0] ?? '/'
        if (req.method !== 'POST' || path !== '/v1/chat/completions') {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
          return
        }
        let body: { model?: string; messages?: Array<{ content?: string }> } = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as typeof body
        } catch {
          /* answered below with an empty prompt */
        }
        const prompt = (body.messages ?? []).map((m) => m.content ?? '').join('\n')
        const reply = answer(prompt)
        fake?.calls.push({ path, model: body.model ?? '', prompt, reply, at: Date.now() })
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: reply } }],
            usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(reply.length / 4) },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    fake = new FakeOllama(server, `http://127.0.0.1:${port}`)
    return fake
  }

  /** The prompt of the first call whose question matches. */
  async call(what: string, match: (question: string) => boolean, timeoutMs = 20_000): Promise<LlmCall> {
    return waitFor(`an LLM call: ${what}`, () => this.calls.find((c) => match(questionOf(c.prompt))), { timeoutMs, intervalMs: 50 })
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

/** The user's question in an orchestrator prompt: what follows the last
 *  "User:" header line (earlier turns are "User: …" on one line). */
export function questionOf(prompt: string): string {
  const at = prompt.lastIndexOf('\nUser:\n')
  if (at < 0) return ''
  return prompt.slice(at + '\nUser:\n'.length).replace(/\n+Foreman:\s*$/, '').trim()
}
