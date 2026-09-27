import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// A hosted MCP server that requires the MCP OAuth flow, on 127.0.0.1 only:
// RFC 9728 protected-resource metadata, RFC 8414 authorization-server
// metadata, RFC 7591 registration, an auto-approving /authorize, a /token
// endpoint that verifies PKCE (S256) and rotates refresh tokens, and a
// streamable-HTTP MCP endpoint (/mcp) plus a plain /probe that both demand a
// live bearer token.

export interface MockOAuthOptions {
  accessTokenTtlSeconds?: number
  rotateRefreshTokens?: boolean
  /** Advertise this authorization endpoint instead of our own. */
  authorizationEndpoint?: string
  /** Leave S256 out of code_challenge_methods_supported. */
  withoutS256?: boolean
  /** Token endpoint answers 500 and echoes what it was sent. */
  tokenEndpointBroken?: boolean
}

interface Client {
  redirectUris: string[]
}
interface PendingCode {
  clientId: string
  redirectUri: string
  challenge: string
  resource: string | null
}

export class MockOAuthServer {
  base = ''
  readonly issued = { access: [] as string[], refresh: [] as string[], codes: [] as string[], clients: [] as string[] }
  readonly calls = { register: 0, authorize: 0, token: 0, refresh: 0, refreshReuse: 0, unauthorized: 0, mcp: 0 }
  readonly bearerSeen: string[] = []
  private server: HttpServer | null = null
  private readonly clients = new Map<string, Client>()
  private readonly codes = new Map<string, PendingCode>()
  private readonly access = new Map<string, number>()
  private readonly refresh = new Map<string, string>()
  private readonly rotatedAway = new Set<string>()

  constructor(private readonly opts: MockOAuthOptions = {}) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500).end(String(err))
      })
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (!s) return
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }

  get mcpUrl(): string {
    return `${this.base}/mcp`
  }

  /** Every token/code/client value this server handed out. */
  allSecrets(): string[] {
    return [...this.issued.access, ...this.issued.refresh, ...this.issued.codes]
  }

  revokeAccessTokens(): void {
    this.access.clear()
  }

  revokeRefreshTokens(): void {
    this.refresh.clear()
  }

  isRefreshTokenActive(token: string): boolean {
    return this.refresh.has(token)
  }

  /** Plays the browser: open the authorization URL, follow the redirect back
   *  to Foreman's loopback listener (optionally with a forged `state`). */
  async approve(authUrl: string, opts: { state?: string } = {}): Promise<number> {
    const res = await fetch(authUrl, { redirect: 'manual' })
    const location = res.headers.get('location')
    if (!location) throw new Error(`authorize answered ${res.status}: ${await res.text()}`)
    const callback = new URL(location)
    if (opts.state !== undefined) callback.searchParams.set('state', opts.state)
    const back = await fetch(callback)
    await back.text()
    return back.status
  }

  private metadata(): Record<string, unknown> {
    return {
      issuer: this.base,
      authorization_endpoint: this.opts.authorizationEndpoint ?? `${this.base}/authorize`,
      token_endpoint: `${this.base}/token`,
      registration_endpoint: `${this.base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: this.opts.withoutS256 ? ['plain'] : ['S256'],
      authorization_response_iss_parameter_supported: true,
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base)
    const path = url.pathname
    if (req.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, {
        resource: this.mcpUrl,
        authorization_servers: [this.base],
        scopes_supported: ['mcp:tools'],
      })
    }
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return json(res, 200, this.metadata())
    }
    if (req.method === 'POST' && path === '/register') return this.register(req, res)
    if (req.method === 'GET' && path === '/authorize') return this.authorize(url, res)
    if (req.method === 'POST' && path === '/token') return this.token(req, res)
    if (path === '/probe' || path === '/mcp') {
      const auth = req.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const exp = this.access.get(token)
      if (!exp || exp < Date.now()) {
        this.calls.unauthorized++
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp"`,
        })
        res.end()
        return
      }
      this.bearerSeen.push(token)
      if (path === '/probe') return json(res, 200, { ok: true })
      this.calls.mcp++
      return this.mcp(req, res)
    }
    res.writeHead(404).end()
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.calls.register++
    const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] }
    const uris = body.redirect_uris ?? []
    if (uris.length === 0 || !uris.every((u) => /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(u))) {
      return json(res, 400, { error: 'invalid_redirect_uri' })
    }
    const clientId = `client-${randomBytes(6).toString('hex')}`
    this.clients.set(clientId, { redirectUris: uris })
    this.issued.clients.push(clientId)
    return json(res, 201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) })
  }

  private authorize(url: URL, res: ServerResponse): void {
    this.calls.authorize++
    const p = url.searchParams
    const client = this.clients.get(p.get('client_id') ?? '')
    const redirectUri = p.get('redirect_uri') ?? ''
    if (!client || !client.redirectUris.includes(redirectUri)) {
      res.writeHead(400).end('unknown client or redirect_uri')
      return
    }
    if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
      res.writeHead(400).end('PKCE S256 required')
      return
    }
    const code = `code-${randomBytes(12).toString('hex')}`
    this.issued.codes.push(code)
    this.codes.set(code, {
      clientId: p.get('client_id')!,
      redirectUri,
      challenge: p.get('code_challenge')!,
      resource: p.get('resource'),
    })
    const back = new URL(redirectUri)
    back.searchParams.set('code', code)
    back.searchParams.set('state', p.get('state') ?? '')
    back.searchParams.set('iss', this.base)
    res.writeHead(302, { location: back.href }).end()
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.calls.token++
    const raw = await readBody(req)
    if (this.opts.tokenEndpointBroken) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(`upstream exploded while handling ${raw}`)
      return
    }
    const p = new URLSearchParams(raw)
    const grant = p.get('grant_type')
    if (grant === 'authorization_code') {
      const pending = this.codes.get(p.get('code') ?? '')
      this.codes.delete(p.get('code') ?? '')
      if (!pending || pending.clientId !== p.get('client_id') || pending.redirectUri !== p.get('redirect_uri')) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' })
      }
      const verifier = p.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (challenge !== pending.challenge) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      }
      return json(res, 200, this.issueTokens(pending.clientId))
    }
    if (grant === 'refresh_token') {
      this.calls.refresh++
      const presented = p.get('refresh_token') ?? ''
      const clientId = this.refresh.get(presented)
      if (!clientId || clientId !== p.get('client_id')) {
        if (this.rotatedAway.has(presented)) this.calls.refreshReuse++
        return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token is not valid' })
      }
      if (this.opts.rotateRefreshTokens !== false) {
        this.refresh.delete(presented)
        this.rotatedAway.add(presented)
        return json(res, 200, this.issueTokens(clientId))
      }
      const { refresh_token: _unused, ...rest } = this.issueTokens(clientId, false)
      return json(res, 200, rest)
    }
    return json(res, 400, { error: 'unsupported_grant_type' })
  }

  private issueTokens(clientId: string, withRefresh = true): Record<string, unknown> {
    const ttl = this.opts.accessTokenTtlSeconds ?? 3600
    const accessToken = `mock-at-${randomBytes(16).toString('hex')}`
    this.access.set(accessToken, Date.now() + ttl * 1000)
    this.issued.access.push(accessToken)
    const out: Record<string, unknown> = { access_token: accessToken, token_type: 'Bearer', expires_in: ttl }
    if (withRefresh) {
      const refreshToken = `mock-rt-${randomBytes(16).toString('hex')}`
      this.refresh.set(refreshToken, clientId)
      this.issued.refresh.push(refreshToken)
      out.refresh_token = refreshToken
    }
    return out
  }

  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = new Server({ name: 'mock-hosted', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'echo',
          description: 'Echo back the text you pass in.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: 'text', text: String((request.params.arguments ?? {}).text ?? '') }],
    }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    const body = req.method === 'POST' ? (JSON.parse(await readBody(req)) as unknown) : undefined
    await transport.handleRequest(req, res, body)
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c: Buffer) => (data += c.toString()))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
