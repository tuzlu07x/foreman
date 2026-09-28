import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { waitFor } from './sandbox.js'

// A local webhook endpoint (127.0.0.1 only) that records what Foreman's
// WebhookChannel posts and verifies it the way docs/notifications.md tells
// receivers to: `X-Foreman-Timestamp` within 5 minutes, and
// `X-Foreman-Signature` = "sha256=" + HMAC-SHA256(secret, "<timestamp>.<raw
// body>"), compared in constant time.

export interface WebhookPayload {
  schema: string
  id: string
  level: string
  requestId: string | null
  title: string
  body: string
  actions: Array<{ id: string; label: string }>
  agentBlocking: boolean
  sentAt: number
}

export interface Delivery {
  path: string
  headers: IncomingHttpHeaders
  raw: string
  payload: WebhookPayload
  signatureValid: boolean
}

const one = (h: string | string[] | undefined): string => (Array.isArray(h) ? (h[0] ?? '') : (h ?? ''))

export function verifySignature(secret: string, raw: string, headers: IncomingHttpHeaders): boolean {
  const ts = one(headers['x-foreman-timestamp'])
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
  const given = Buffer.from(one(headers['x-foreman-signature']))
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export class WebhookReceiver {
  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly deliveries: Delivery[],
  ) {}

  static async start(secret: string): Promise<WebhookReceiver> {
    const deliveries: Delivery[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        const signatureValid = verifySignature(secret, raw, req.headers)
        try {
          deliveries.push({ path: req.url ?? '', headers: req.headers, raw, payload: JSON.parse(raw) as WebhookPayload, signatureValid })
        } catch {
          res.writeHead(400).end()
          return
        }
        res.writeHead(signatureValid ? 200 : 401, { 'content-type': 'application/json' }).end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return new WebhookReceiver(server, `http://127.0.0.1:${port}/foreman/hook`, deliveries)
  }

  async next(what: string, match: (d: Delivery) => boolean, timeoutMs = 20_000): Promise<Delivery> {
    return waitFor(`webhook delivery: ${what}`, () => this.deliveries.find(match), { timeoutMs, intervalMs: 50 })
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
