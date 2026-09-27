import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { DiscordGatewayListener } from '../../../src/core/notification/channels/discord-gateway.js'
import { waitFor } from './fake-socket.js'

// =============================================================================
// #615 — The listeners on Node's built-in WebSocket (no dependency), against
// a minimal RFC 6455 server on localhost.
// =============================================================================

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(text: string): Buffer {
  const payload = Buffer.from(text)
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, payload])
}

/** Parse complete client frames (always masked) out of `buf`. */
function parseFrames(buf: Buffer): { texts: string[]; rest: Buffer; closed: boolean } {
  const texts: string[] = []
  let closed = false
  let offset = 0
  while (buf.length - offset >= 2) {
    const opcode = buf[offset]! & 0x0f
    let len = buf[offset + 1]! & 0x7f
    let at = offset + 2
    if (len === 126) {
      if (buf.length < at + 2) break
      len = buf.readUInt16BE(at)
      at += 2
    }
    if (buf.length < at + 4 + len) break
    const mask = buf.subarray(at, at + 4)
    const data = Buffer.from(buf.subarray(at + 4, at + 4 + len))
    for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!
    if (opcode === 1) texts.push(data.toString('utf8'))
    if (opcode === 8) closed = true
    offset = at + 4 + len
  }
  return { texts, rest: buf.subarray(offset), closed }
}

function gateway(onText: (text: string, send: (payload: unknown) => void) => void): Promise<{ server: Server; url: string }> {
  const server = createServer()
  server.on('upgrade', (req, socket: Duplex) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const send = (payload: unknown): void => {
      socket.write(frame(JSON.stringify(payload)))
    }
    let pending: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      const parsed = parseFrames(Buffer.concat([pending, chunk]))
      pending = parsed.rest
      for (const t of parsed.texts) onText(t, send)
      if (parsed.closed) socket.end()
    })
    socket.on('error', () => undefined)
    send({ op: 10, d: { heartbeat_interval: 60_000 } })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, url: `ws://127.0.0.1:${port}` })
    })
  })
}

describe('real WebSocket', () => {
  let server: Server | null = null
  let listener: DiscordGatewayListener | null = null
  afterEach(async () => {
    await listener?.stop()
    await new Promise((r) => server?.close(r) ?? r(null))
    server?.closeAllConnections?.()
  })

  it('identifies over Node\'s built-in WebSocket', async () => {
    const received: Array<{ op: number; d: Record<string, unknown> }> = []
    const started = await gateway((text) => {
      received.push(JSON.parse(text) as { op: number; d: Record<string, unknown> })
    })
    server = started.server
    listener = new DiscordGatewayListener({
      botToken: 'bot-token',
      allowedUserIds: ['111111111111111111'],
      gatewayUrl: started.url,
      random: () => 0.5,
    })
    listener.start(async () => {})
    await waitFor(() => received.some((p) => p.op === 2), 5_000)
    expect(received.find((p) => p.op === 2)!.d).toMatchObject({ token: 'bot-token', intents: 0 })
  })
})
