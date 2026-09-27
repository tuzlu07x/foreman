import type { SocketCloseEvent, SocketLike, SocketMessageEvent } from '../../../src/core/notification/channels/socket.js'

// In-memory WebSocket pair for the Slack Socket Mode and Discord Gateway
// tests: the test plays the server side (receive / serverClose), the code
// under test sees a SocketLike.

type Listener = ((ev: SocketMessageEvent) => void) | ((ev: SocketCloseEvent) => void) | (() => void)

export class FakeSocket implements SocketLike {
  readonly sent: Array<Record<string, unknown>> = []
  closed: SocketCloseEvent | null = null
  /** A dead link: our close() never gets the peer's close frame back. */
  silent = false
  private readonly listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] }

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.closed) throw new Error('socket closed')
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = { code, reason }
    if (this.silent) return
    queueMicrotask(() => {
      for (const l of this.listeners.close!) (l as (ev: SocketCloseEvent) => void)({ code, reason })
    })
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners[type]?.push(listener)
  }

  /** The server sends a frame. */
  receive(payload: unknown): void {
    for (const l of this.listeners.message!) (l as (ev: SocketMessageEvent) => void)({ data: JSON.stringify(payload) })
  }

  /** The server drops the connection. */
  serverClose(code: number, reason = ''): void {
    this.close(code, reason)
  }
}

export function fakeSocketServer(opts: { silent?: boolean } = {}) {
  const sockets: FakeSocket[] = []
  const factory = (url: string): FakeSocket => {
    const s = new FakeSocket(url)
    s.silent = opts.silent === true
    sockets.push(s)
    return s
  }
  /** Wait until the n-th connection (1-based) is opened. */
  const connection = async (n: number, timeoutMs = 2_000): Promise<FakeSocket> => {
    const until = Date.now() + timeoutMs
    while (sockets.length < n) {
      if (Date.now() > until) throw new Error(`no connection #${n} (have ${sockets.length})`)
      await new Promise((r) => setTimeout(r, 5))
    }
    return sockets[n - 1]!
  }
  return { sockets, factory, connection }
}

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** HttpFetch double: records calls, answers with `respond(url)`. */
export function httpRecorder(respond: (url: string, body: unknown) => { status?: number; body: unknown }) {
  const calls: RecordedCall[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    const raw = typeof init.body === 'string' ? init.body : ''
    let body: unknown = raw
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      /* form or empty body */
    }
    calls.push({ url, method: String(init.method ?? 'GET'), headers: (init.headers ?? {}) as Record<string, string>, body })
    const answer = respond(url, body)
    const status = answer.status ?? 200
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return { ok: status >= 200 && status < 300, status, text: async () => text }
  }
  return { calls, fetchImpl }
}

export const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await settle(5)
  }
}
