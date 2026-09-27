import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubConfigSchema, mcpOAuthSecretName } from '../../../src/core/mcp-hub/config.js'
import { McpHub } from '../../../src/core/mcp-hub/hub.js'
import { McpOAuthRequiredError } from '../../../src/core/mcp-hub/oauth-http.js'
import { runMcpOAuthLogin, startLoopbackReceiver } from '../../../src/core/mcp-hub/oauth-login.js'
import { McpOAuthSession } from '../../../src/core/mcp-hub/oauth-session.js'
import {
  loadMcpOAuthRecord,
  mcpOAuthStatus,
  saveMcpOAuthRecord,
  type McpOAuthRecord,
} from '../../../src/core/mcp-hub/oauth-store.js'
import { ToolPinStore } from '../../../src/core/mcp-hub/pins.js'
import { SecretStore } from '../../../src/core/secret-store.js'
import { createInMemoryDb } from '../../../src/db/client.js'
import { generateMasterKey } from '../../../src/identity/encryption.js'
import { MockOAuthServer, type MockOAuthOptions } from './fixtures/mock-oauth-server.js'

const TWO_HOURS = 2 * 60 * 60 * 1000

describe('MCP hub OAuth', () => {
  let sqlite: Database.Database
  let store: SecretStore
  let dir: string
  let mock: MockOAuthServer
  const hubs: McpHub[] = []

  async function startMock(opts: MockOAuthOptions = {}): Promise<MockOAuthServer> {
    await mock.stop()
    mock = new MockOAuthServer(opts)
    await mock.start()
    return mock
  }

  async function login(opts: { state?: string } = {}): Promise<McpOAuthRecord> {
    const record = await runMcpOAuthLogin({
      server: 'hosted',
      serverUrl: mock.mcpUrl,
      timeoutMs: 10_000,
      presentAuthUrl: async (url) => {
        await mock.approve(url, opts)
      },
    })
    saveMcpOAuthRecord(store, record)
    return record
  }

  function session(extra: Partial<ConstructorParameters<typeof McpOAuthSession>[0]> = {}): McpOAuthSession {
    return new McpOAuthSession({ server: 'hosted', serverUrl: mock.mcpUrl, store, lockPath: null, ...extra })
  }

  beforeEach(async () => {
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, generateMasterKey())
    dir = mkdtempSync(join(tmpdir(), 'foreman-hub-oauth-'))
    mock = new MockOAuthServer()
    await mock.start()
  })

  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.close()))
    await mock.stop()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('login', () => {
    it('discovers metadata, registers a client, runs PKCE S256 and stores the session encrypted', async () => {
      let authUrl = ''
      const record = await runMcpOAuthLogin({
        server: 'hosted',
        serverUrl: mock.mcpUrl,
        timeoutMs: 10_000,
        presentAuthUrl: async (url) => {
          authUrl = url
          await mock.approve(url)
        },
      })
      saveMcpOAuthRecord(store, record)

      const params = new URL(authUrl).searchParams
      expect(params.get('code_challenge_method')).toBe('S256')
      expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(params.get('state')).toMatch(/^[0-9a-f]{32}$/)
      expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      expect(params.get('resource')).toBe(mock.mcpUrl)
      expect(params.get('scope')).toBe('mcp:tools')
      expect(mock.calls.register).toBe(1)
      expect(mock.calls.token).toBe(1)

      expect(record.tokens.access_token).toBe(mock.issued.access[0])
      expect(record.tokens.refresh_token).toBe(mock.issued.refresh[0])
      expect(record.server_url).toBe(mock.mcpUrl)
      expect(loadMcpOAuthRecord(store, 'hosted')?.tokens.access_token).toBe(mock.issued.access[0])

      // At rest the bundle is ciphertext only.
      const row = sqlite
        .prepare('SELECT value_encrypted FROM secrets WHERE name = ?')
        .get(mcpOAuthSecretName('hosted')) as { value_encrypted: Buffer | string }
      const stored = Buffer.from(row.value_encrypted as never).toString('latin1')
      for (const secret of mock.allSecrets()) expect(stored).not.toContain(secret)
    })

    it('refuses a callback whose state does not match, and never exchanges the code', async () => {
      await expect(login({ state: 'forged-state' })).rejects.toThrow(/state mismatch/)
      expect(mock.calls.token).toBe(0)
      expect(loadMcpOAuthRecord(store, 'hosted')).toBeNull()
    })

    it('fails closed when the authorization server rejects a wrong code verifier', async () => {
      const tamper = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        if (String(url).endsWith('/token') && init?.body instanceof URLSearchParams) {
          init.body.set('code_verifier', 'x'.repeat(64))
        }
        return fetch(url, init)
      }
      const attempt = runMcpOAuthLogin({
        server: 'hosted',
        serverUrl: mock.mcpUrl,
        timeoutMs: 10_000,
        fetchFn: tamper,
        presentAuthUrl: async (url) => {
          await mock.approve(url)
        },
      })
      await expect(attempt).rejects.toThrow(/invalid_grant: PKCE verification failed/)
      expect(mock.issued.access).toHaveLength(0)
    })

    it('refuses a non-https authorization endpoint before showing any URL', async () => {
      await startMock({ authorizationEndpoint: 'http://auth.example.com/authorize' })
      let shown = false
      await expect(
        runMcpOAuthLogin({
          server: 'hosted',
          serverUrl: mock.mcpUrl,
          timeoutMs: 10_000,
          presentAuthUrl: () => {
            shown = true
          },
        }),
      ).rejects.toThrow(/non-https authorization endpoint/)
      expect(shown).toBe(false)
      expect(mock.calls.register).toBe(0)
    })

    it('refuses an authorization server that does not offer PKCE S256', async () => {
      await startMock({ withoutS256: true })
      await expect(login()).rejects.toThrow(/S256/)
      expect(mock.calls.register).toBe(0)
    })
  })

  describe('loopback redirect listener', () => {
    it('binds 127.0.0.1, accepts exactly one callback and validates state', async () => {
      const receiver = await startLoopbackReceiver({ state: 'expected', timeoutMs: 10_000 })
      expect(receiver.host).toBe('127.0.0.1')
      expect(receiver.redirectUri).toBe(`http://127.0.0.1:${receiver.port}/callback`)
      const ok = await fetch(`${receiver.redirectUri}?code=abc&state=expected`)
      expect(ok.status).toBe(200)
      await expect(receiver.result).resolves.toBe('abc')
      await expect(fetch(`${receiver.redirectUri}?code=again&state=expected`)).rejects.toThrow()
      receiver.close()
    })

    it('ends the flow on the first callback when its state is wrong', async () => {
      const receiver = await startLoopbackReceiver({ state: 'expected', timeoutMs: 10_000 })
      const bad = await fetch(`${receiver.redirectUri}?code=abc&state=nope`)
      expect(bad.status).toBe(400)
      await expect(receiver.result).rejects.toThrow(/state mismatch/)
    })

    it('rejects a callback from a different issuer (RFC 9207)', async () => {
      const receiver = await startLoopbackReceiver({ state: 's', timeoutMs: 10_000, issuer: 'https://as.example' })
      await fetch(`${receiver.redirectUri}?code=abc&state=s&iss=https%3A%2F%2Fevil.example`)
      await expect(receiver.result).rejects.toThrow(/different issuer/)
    })

    it('times out', async () => {
      const receiver = await startLoopbackReceiver({ state: 's', timeoutMs: 50 })
      await expect(receiver.result).rejects.toThrow(/timed out/)
    })
  })

  describe('session', () => {
    it('refreshes before expiry and persists the rotated refresh token', async () => {
      const first = await login()
      const s = session({ now: () => Date.now() + TWO_HOURS })
      const token = await s.accessToken()

      expect(mock.calls.refresh).toBe(1)
      expect(token).toBe(mock.issued.access[1])
      const stored = loadMcpOAuthRecord(store, 'hosted')!
      expect(stored.tokens.access_token).toBe(token)
      expect(stored.tokens.refresh_token).toBe(mock.issued.refresh[1])
      expect(stored.tokens.refresh_token).not.toBe(first.tokens.refresh_token)
      expect(mock.isRefreshTokenActive(first.tokens.refresh_token!)).toBe(false)
    })

    it('keeps the old refresh token when the server does not rotate it', async () => {
      await startMock({ rotateRefreshTokens: false })
      const first = await login()
      await session({ now: () => Date.now() + TWO_HOURS }).accessToken()
      expect(loadMcpOAuthRecord(store, 'hosted')!.tokens.refresh_token).toBe(first.tokens.refresh_token)
    })

    it('on 401 refreshes once and retries the request', async () => {
      await login()
      const s = session()
      mock.revokeAccessTokens()
      const res = await s.fetch(`${mock.base}/probe`)
      expect(res.status).toBe(200)
      expect(mock.calls.unauthorized).toBe(1)
      expect(mock.calls.refresh).toBe(1)
      expect(mock.bearerSeen).toEqual([mock.issued.access[1]])
    })

    it('two processes refreshing at once use the rotated refresh token only once', async () => {
      await login()
      const lockPath = join(dir, 'hosted.lock')
      const later = (): number => Date.now() + TWO_HOURS
      const a = session({ lockPath, now: later })
      const b = session({ lockPath, now: later })
      const [ta, tb] = await Promise.all([a.accessToken(), b.accessToken()])
      expect(ta).toBe(tb)
      expect(mock.calls.refresh).toBe(1)
      expect(mock.calls.refreshReuse).toBe(0)
    })

    it('a refused refresh marks the session as needing login', async () => {
      await login()
      mock.revokeRefreshTokens()
      const s = session({ now: () => Date.now() + TWO_HOURS })
      await expect(s.accessToken()).rejects.toBeInstanceOf(McpOAuthRequiredError)
      const status = mcpOAuthStatus(store, 'hosted', mock.mcpUrl)
      expect(status.state).toBe('needs-login')
    })

    it('never sends a token to a URL other than the one it was issued for', async () => {
      await login()
      const moved = session({ serverUrl: `${mock.base}/other` })
      await expect(moved.accessToken()).rejects.toThrow(/server URL in mcp.yaml changed/)
      await expect(session().fetch('http://127.0.0.2:9/mcp')).rejects.toThrow(/refusing to send/)
      expect(mock.bearerSeen).toHaveLength(0)
    })

    it('scrubs tokens from error text when the token endpoint echoes them', async () => {
      await login()
      await mock.stop()
      const broken = new MockOAuthServer({ tokenEndpointBroken: true })
      await broken.start()
      // Point the stored session at the broken token endpoint.
      const record = loadMcpOAuthRecord(store, 'hosted')!
      saveMcpOAuthRecord(store, {
        ...record,
        metadata: { ...record.metadata, token_endpoint: `${broken.base}/token` },
      })
      const s = session({ now: () => Date.now() + TWO_HOURS })
      const err = await s.accessToken().catch((e: unknown) => e as Error)
      await broken.stop()
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('token refresh')
      // The endpoint did echo the refresh token back — and it was masked.
      expect((err as Error).message).toContain('[redacted]')
      for (const secret of [record.tokens.access_token, record.tokens.refresh_token!]) {
        expect((err as Error).message).not.toContain(secret)
      }
    })
  })

  describe('hub', () => {
    function oauthHub(): McpHub {
      const config = HubConfigSchema.parse({
        servers: { hosted: { url: mock.mcpUrl, auth: 'oauth', tools: { allow: ['echo'] } } },
      })
      const h = new McpHub({
        config,
        resolveSecret: () => null,
        pins: new ToolPinStore(join(dir, 'pins.json')),
        oauth: (server, url) => new McpOAuthSession({ server, serverUrl: url, store, lockPath: null }),
      })
      hubs.push(h)
      return h
    }

    it('keeps an OAuth server offline until login, with a clear hint', async () => {
      const h = oauthHub()
      expect(await h.listForAgent()).toEqual([])
      const status = h.status()[0]!
      expect(status.source).toBe('unavailable')
      expect(status.error).toContain('foreman mcp login hosted')
      expect(mock.calls.mcp).toBe(0)
    })

    it('attaches the bearer token upstream and recovers from a 401 mid-session', async () => {
      await login()
      const h = oauthHub()
      const tools = await h.listForAgent()
      expect(tools.map((t) => t.name)).toEqual(['hosted__echo'])
      expect(mock.bearerSeen.every((t) => t === mock.issued.access[0])).toBe(true)

      mock.revokeAccessTokens()
      const resolution = await h.resolveCall('hosted__echo', { text: 'hi' })
      if (resolution?.kind !== 'tool') throw new Error('expected a tool')
      const { result } = await h.call(resolution.tool, resolution.args)
      expect(result.content).toEqual([{ type: 'text', text: 'hi' }])
      expect(mock.calls.refresh).toBe(1)
      expect(loadMcpOAuthRecord(store, 'hosted')!.tokens.access_token).toBe(mock.issued.access[1])
    })

    it('a hub without OAuth support keeps such servers offline (fail closed)', async () => {
      await login()
      const config = HubConfigSchema.parse({ servers: { hosted: { url: mock.mcpUrl, auth: 'oauth' } } })
      const h = new McpHub({ config, resolveSecret: () => null, pins: new ToolPinStore(null) })
      hubs.push(h)
      await h.inventory({ refresh: true })
      expect(h.status()[0]!.error).toContain('uses OAuth')
      expect(mock.bearerSeen).toHaveLength(0)
    })
  })

  describe('mcp.yaml', () => {
    it('requires a url for auth: oauth', () => {
      expect(() => HubConfigSchema.parse({ servers: { x: { command: 'npx', auth: 'oauth' } } })).toThrow(
        /auth: oauth/,
      )
    })

    it('rejects a hand-written Authorization header on an OAuth server', () => {
      expect(() =>
        HubConfigSchema.parse({
          servers: { x: { url: 'https://mcp.example.com/mcp', auth: 'oauth', headers: { authorization: 'Bearer x' } } },
        }),
      ).toThrow(/Authorization header/)
    })

    it('refuses references to the reserved OAuth session secrets', () => {
      expect(() =>
        HubConfigSchema.parse({
          servers: {
            x: { url: 'https://mcp.example.com/mcp', headers: { 'X-Token': '${secret:mcp-oauth-linear}' } },
          },
        }),
      ).toThrow(/reserved/)
    })
  })
})
