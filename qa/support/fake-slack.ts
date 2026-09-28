import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { waitFor } from './sandbox.js'

// =============================================================================
// A fake Slack on 127.0.0.1 — Web API, reply URLs and Socket Mode
// =============================================================================
//
// `foreman start` reaches it through FOREMAN_TEST_SLACK_ORIGIN
// (src/core/notification/channels/slack-endpoints.ts), which only accepts
// `http://127.0.0.1:<port>`. What it serves:
//
//   POST /api/<method>   the Web API Foreman calls: apps.connections.open
//                        (app token), chat.postMessage and chat.update (bot
//                        token). Every call is recorded; a wrong token gets
//                        Slack's `invalid_auth`.
//   POST /hooks/<id>     the `response_url` of a button tap or a slash
//                        command: Foreman's replies land here.
//   GET  /socket         Socket Mode, a WebSocket (RFC 6455, written out
//                        here so the suite needs no dependency). The test
//                        pushes `slash_commands` / `interactive` envelopes as
//                        a given Slack user and reads Foreman's acks.

export interface ApiCall {
  method: string
  token: string | null
  body: Record<string, unknown>
  at: number
  /** What the fake answered. */
  response: Record<string, unknown>
}

export interface HookPost {
  path: string
  body: Record<string, unknown>
  at: number
}

/** A chat.postMessage as a person would read it in the channel. */
export interface SlackMessage extends ApiCall {
  channel: string
  text: string
  ts: string
}

interface Block {
  type?: string
  elements?: Array<{ type?: string; action_id?: string; value?: string; text?: { text?: string } }>
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export class FakeSlack {
  readonly calls: ApiCall[] = []
  readonly hooks: HookPost[] = []
  /** Frames Foreman sent over Socket Mode (acks carry `envelope_id`). */
  readonly received: Array<Record<string, unknown>> = []
  private readonly sockets: WsConnection[] = []
  private connectionsOpened = 0
  private counter = 0

  private constructor(
    private readonly server: Server,
    readonly origin: string,
    private readonly tokens: { bot: string; app: string },
  ) {}

  static async start(tokens: { bot: string; app: string }): Promise<FakeSlack> {
    let fake: FakeSlack | null = null
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        const answer = fake?.handle(req.method ?? 'GET', req.url ?? '/', req.headers, raw) ?? { status: 503, body: {} }
        res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body))
      })
    })
    server.on('upgrade', (req, socket: Duplex) => {
      if (!fake || !(req.url ?? '').startsWith('/socket') || typeof req.headers['sec-websocket-key'] !== 'string') {
        socket.destroy()
        return
      }
      fake.accept(req.headers['sec-websocket-key'], socket)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    fake = new FakeSlack(server, `http://127.0.0.1:${port}`, tokens)
    return fake
  }

  private handle(method: string, url: string, headers: IncomingHttpHeaders, raw: string): { status: number; body: unknown } {
    const path = url.split('?')[0] ?? ''
    const at = Date.now()
    if (method === 'POST' && path.startsWith('/hooks/')) {
      this.hooks.push({ path, body: parse(raw), at })
      return { status: 200, body: { ok: true } }
    }
    if (method !== 'POST' || !path.startsWith('/api/')) return { status: 404, body: { ok: false, error: 'not_found' } }
    const api = path.slice('/api/'.length)
    const auth = String(headers.authorization ?? '')
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
    const call: ApiCall = { method: api, token, body: parse(raw), at, response: {} }
    this.calls.push(call)
    const answer = this.api(call)
    call.response = answer
    return { status: 200, body: answer }
  }

  private api({ method, token, body, at }: ApiCall): Record<string, unknown> {
    switch (method) {
      case 'apps.connections.open':
        if (token !== this.tokens.app) return { ok: false, error: 'invalid_auth' }
        this.connectionsOpened += 1
        return { ok: true, url: `ws://${this.origin.slice('http://'.length)}/socket?ticket=${this.connectionsOpened}` }
      case 'chat.postMessage':
      case 'chat.update': {
        if (token !== this.tokens.bot) return { ok: false, error: 'invalid_auth' }
        const channel = typeof body.channel === 'string' ? body.channel : ''
        if (!channel) return { ok: false, error: 'channel_not_found' }
        const ts = method === 'chat.update' ? String(body.ts ?? '') : `${Math.floor(at / 1000)}.${String(++this.counter).padStart(6, '0')}`
        return { ok: true, channel, ts }
      }
      default:
        return { ok: false, error: 'unknown_method' }
    }
  }

  private accept(key: string, socket: Duplex): void {
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
    )
    const conn = new WsConnection(socket, (text) => {
      try {
        this.received.push(JSON.parse(text) as Record<string, unknown>)
      } catch {
        /* not JSON: ignore */
      }
    })
    this.sockets.push(conn)
    conn.send({ type: 'hello', num_connections: 1, debug_info: { host: 'qa-fake-slack' } })
  }

  // --- what Foreman did -----------------------------------------------------

  /** Messages Foreman posted (chat.postMessage) to `channel`, oldest first. */
  messages(channel?: string): SlackMessage[] {
    return this.calls
      .filter((c) => c.method === 'chat.postMessage' && (channel === undefined || c.body.channel === channel))
      .map((c) => ({ ...c, channel: String(c.body.channel ?? ''), text: String(c.body.text ?? ''), ts: String(c.response.ts ?? '') }))
  }

  async message(what: string, match: (m: SlackMessage) => boolean, timeoutMs = 20_000): Promise<SlackMessage> {
    return waitFor(`Slack message: ${what}`, () => this.messages().find(match), { timeoutMs, intervalMs: 50 })
  }

  async hook(what: string, path: string, timeoutMs = 15_000): Promise<HookPost> {
    return waitFor(`reply on ${path}: ${what}`, () => this.hooks.find((h) => h.path === path), { timeoutMs, intervalMs: 50 })
  }

  async connected(timeoutMs = 20_000): Promise<void> {
    await waitFor('Foreman to open Socket Mode', () => this.sockets.some((s) => s.open), { timeoutMs, intervalMs: 50 })
  }

  // --- what a person in Slack does ------------------------------------------

  /** `/foreman <text>` typed by `userId`. Returns the envelope id and the
   *  response_url Foreman must answer on. */
  slash(userId: string, text: string): { envelopeId: string; responseUrl: string; path: string } {
    const path = `/hooks/commands/${this.nextId()}`
    const envelopeId = this.push('slash_commands', {
      command: '/foreman',
      text,
      user_id: userId,
      user_name: userId.toLowerCase(),
      channel_id: 'C0QA',
      team_id: 'T0QA',
      response_url: `${this.origin}${path}`,
      trigger_id: this.nextId(),
    })
    return { envelopeId, responseUrl: `${this.origin}${path}`, path }
  }

  /** `userId` taps the button `actionId` (e.g. `foreman_allow`) on a message
   *  Foreman posted. */
  tap(userId: string, message: SlackMessage, actionId: string): { envelopeId: string; path: string } {
    const blocks = (Array.isArray(message.body.blocks) ? message.body.blocks : []) as Block[]
    const button = blocks.flatMap((b) => (b.type === 'actions' ? (b.elements ?? []) : [])).find((e) => e.action_id === actionId)
    if (!button?.value) throw new Error(`no ${actionId} button on "${message.text.slice(0, 80)}"`)
    const path = `/hooks/actions/${this.nextId()}`
    const envelopeId = this.push('interactive', {
      type: 'block_actions',
      user: { id: userId, username: userId.toLowerCase() },
      team: { id: 'T0QA' },
      channel: { id: message.channel },
      response_url: `${this.origin}${path}`,
      message: { ts: message.ts, text: message.body.text, blocks },
      actions: [{ type: 'button', action_id: actionId, block_id: 'foreman_approval', value: button.value }],
    })
    return { envelopeId, path }
  }

  /** Wait until Foreman acknowledged an envelope (it must, within 3 s). */
  async acked(envelopeId: string, timeoutMs = 3_000): Promise<void> {
    await waitFor(`the ack of ${envelopeId}`, () => this.received.some((f) => f.envelope_id === envelopeId), { timeoutMs, intervalMs: 20 })
  }

  private push(type: string, payload: Record<string, unknown>): string {
    const socket = [...this.sockets].reverse().find((s) => s.open)
    if (!socket) throw new Error('Foreman has no Socket Mode connection open')
    const envelopeId = `qa-env-${this.nextId()}`
    socket.send({ envelope_id: envelopeId, type, accepts_response_payload: false, payload })
    return envelopeId
  }

  private nextId(): string {
    return `${++this.counter}-${randomBytes(4).toString('hex')}`
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function parse(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

/** The server side of one WebSocket: unmasked frames out, masked frames in. */
class WsConnection {
  open = true
  private buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []

  constructor(
    private readonly socket: Duplex,
    private readonly onText: (text: string) => void,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    socket.on('close', () => (this.open = false))
    socket.on('error', () => (this.open = false))
  }

  send(value: unknown): void {
    this.frame(0x1, Buffer.from(JSON.stringify(value)))
  }

  destroy(): void {
    this.open = false
    this.socket.destroy()
  }

  private frame(opcode: number, payload: Buffer): void {
    if (!this.open) return
    const len = payload.length
    const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10)
    if (len >= 126 && len < 65_536) {
      head[0] = 0x80 | opcode
      head[1] = 126
      head.writeUInt16BE(len, 2)
    } else if (len >= 65_536) {
      head[0] = 0x80 | opcode
      head[1] = 127
      head.writeBigUInt64BE(BigInt(len), 2)
    }
    this.socket.write(Buffer.concat([head, payload]))
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return
      const b0 = this.buffer[0]!
      const b1 = this.buffer[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (this.buffer.length < 4) return
        len = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.buffer.length < 10) return
        len = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (this.buffer.length < offset + maskLen + len) return
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
      this.buffer = this.buffer.subarray(offset + maskLen + len)
      if (opcode === 0x8) {
        // Echo the close, then hang up.
        this.frame(0x8, payload.subarray(0, 2))
        this.open = false
        this.socket.end()
        return
      }
      if (opcode === 0x9) {
        this.frame(0xa, payload)
        continue
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload)
        if (fin) {
          this.onText(Buffer.concat(this.fragments).toString('utf-8'))
          this.fragments = []
        }
      }
    }
  }
}
