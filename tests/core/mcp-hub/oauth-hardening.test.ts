import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubConfigSchema } from '../../../src/core/mcp-hub/config.js'
import { McpHub, scrubKnownValues } from '../../../src/core/mcp-hub/hub.js'
import { McpOAuthRequiredError } from '../../../src/core/mcp-hub/oauth-http.js'
import { withLockFile } from '../../../src/core/mcp-hub/oauth-lock.js'
import { runMcpOAuthLogin } from '../../../src/core/mcp-hub/oauth-login.js'
import {
  McpOAuthSession,
  removeMcpOAuthSession,
  revokeMcpOAuthTokens,
  storeMcpOAuthLogin,
} from '../../../src/core/mcp-hub/oauth-session.js'
import {
  clearMcpOAuthRecord,
  isExpiring,
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

// Regressions from the #617 review: races between writers, short-lived
// tokens, credentials echoed in results, redirects with a bearer, and the
// OAuth hardening checks.

const TWO_HOURS = 2 * 60 * 60 * 1000

describe('MCP hub OAuth hardening', () => {
  let sqlite: Database.Database
  let store: SecretStore
  let dir: string
  let mock: MockOAuthServer
  const hubs: McpHub[] = []
  const extraServers: HttpServer[] = []

  async function startMock(opts: MockOAuthOptions = {}): Promise<void> {
    await mock.stop()
    mock = new MockOAuthServer(opts)
    await mock.start()
  }

  async function login(
    opts: { scope?: string; fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response> } = {},
  ): Promise<McpOAuthRecord> {
    const record = await runMcpOAuthLogin({
      server: 'hosted',
      serverUrl: mock.mcpUrl,
      timeoutMs: 10_000,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      presentAuthUrl: async (url) => {
        await mock.approve(url)
      },
    })
    saveMcpOAuthRecord(store, record)
    return record
  }

  function session(extra: Partial<ConstructorParameters<typeof McpOAuthSession>[0]> = {}): McpOAuthSession {
    return new McpOAuthSession({ server: 'hosted', serverUrl: mock.mcpUrl, store, lockPath: null, ...extra })
  }

  /** A server on another origin that records any Authorization header. */
  async function bystander(): Promise<{ url: string; seen: string[] }> {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? '')
      res.writeHead(200).end('ok')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    extraServers.push(server)
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/steal`, seen }
  }

  beforeEach(async () => {
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, generateMasterKey())
    dir = mkdtempSync(join(tmpdir(), 'foreman-hub-oauth-hardening-'))
    mock = new MockOAuthServer()
    await mock.start()
  })

  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.close()))
    await mock.stop()
    for (const s of extraServers.splice(0)) {
      s.closeAllConnections()
      await new Promise((r) => s.close(r))
    }
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('writers racing a refresh (review #1)', () => {
    it('a logout during an in-flight refresh stays logged out', async () => {
      await startMock({ tokenDelayMs: 300 })
      await login()
      const lockPath = join(dir, 'hosted.lock')
      const pending = session({ lockPath, now: () => Date.now() + TWO_HOURS })
        .accessToken()
        .catch((e: unknown) => e)
      await delay(60) // the refresh holds the lock and waits on /token
      const { removed } = await removeMcpOAuthSession(store, 'hosted', lockPath)
      expect(removed).toBe(true)
      await pending
      expect(loadMcpOAuthRecord(store, 'hosted')).toBeNull()
    })

    it('a refresh never re-creates a session removed by a writer that ignored the lock', async () => {
      await startMock({ tokenDelayMs: 300 })
      await login()
      const pending = session({ now: () => Date.now() + TWO_HOURS })
        .accessToken()
        .catch((e: unknown) => e)
      await delay(60)
      clearMcpOAuthRecord(store, 'hosted')
      expect(await pending).toBeInstanceOf(McpOAuthRequiredError)
      expect(loadMcpOAuthRecord(store, 'hosted')).toBeNull()
    })

    it('a re-login during a refresh wins over the refreshed tokens', async () => {
      await startMock({ tokenDelayMs: 300 })
      const first = await login()
      const pending = session({ now: () => Date.now() + TWO_HOURS }).accessToken()
      await delay(60)
      const relogin: McpOAuthRecord = {
        ...first,
        tokens: { access_token: 'relogin-access-token', token_type: 'Bearer', refresh_token: 'relogin-refresh' },
        expires_at: Date.now() + 10 * TWO_HOURS,
        obtained_at: Date.now() + TWO_HOURS,
      }
      saveMcpOAuthRecord(store, relogin)
      expect(await pending).toBe('relogin-access-token')
      expect(loadMcpOAuthRecord(store, 'hosted')!.tokens.access_token).toBe('relogin-access-token')
    })

    it('login, logout and remove wait for the session lock', async () => {
      const record = await login()
      const lockPath = join(dir, 'hosted.lock')
      for (const write of [
        () => storeMcpOAuthLogin(store, record, lockPath),
        () => removeMcpOAuthSession(store, 'hosted', lockPath),
      ]) {
        let released = false
        const held = withLockFile(lockPath, async () => {
          await delay(150)
          released = true
        })
        await delay(20)
        await write()
        expect(released).toBe(true)
        await held
      }
    })

    it('a running session stops using the token as soon as it is logged out', async () => {
      await login()
      const s = session()
      expect(await s.accessToken()).toBe(mock.issued.access[0])
      clearMcpOAuthRecord(store, 'hosted')
      await expect(s.accessToken()).rejects.toBeInstanceOf(McpOAuthRequiredError)
      await expect(s.fetch(`${mock.base}/probe`)).rejects.toBeInstanceOf(McpOAuthRequiredError)
    })

    it('logout revokes the tokens at the provider (RFC 7009), best effort', async () => {
      const record = await login()
      const { record: removed } = await removeMcpOAuthSession(store, 'hosted', null)
      const result = await revokeMcpOAuthTokens(removed!)
      expect(result.revoked).toBe(true)
      expect(mock.revoked).toEqual([record.tokens.refresh_token, record.tokens.access_token])
      expect(mock.isRefreshTokenActive(record.tokens.refresh_token!)).toBe(false)

      const noEndpoint = { ...record, metadata: { ...record.metadata, revocation_endpoint: undefined } }
      const skipped = await revokeMcpOAuthTokens(noEndpoint)
      expect(skipped.revoked).toBe(false)
      const down = await revokeMcpOAuthTokens({
        ...record,
        metadata: { ...record.metadata, revocation_endpoint: 'http://127.0.0.1:9/revoke' },
      })
      expect(down.revoked).toBe(false)
      expect(down.detail).not.toContain(record.tokens.access_token)
    })
  })

  describe('status reads (review #9)', () => {
    it('mcp list / doctor status checks do not record a secret access', async () => {
      await login()
      const before = store.list().find((s) => s.name === 'mcp-oauth-hosted')!.lastAccessedAt
      expect(mcpOAuthStatus(store, 'hosted', mock.mcpUrl).state).toBe('logged-in')
      expect(store.list().find((s) => s.name === 'mcp-oauth-hosted')!.lastAccessedAt).toBe(before)
    })
  })

  describe('short-lived tokens (review #3)', () => {
    it('uses a 30 s token for half its life instead of refreshing on every request', async () => {
      await startMock({ accessTokenTtlSeconds: 30 })
      const record = await login()
      const s = session()
      for (let i = 0; i < 5; i++) expect((await s.fetch(`${mock.base}/probe`)).status).toBe(200)
      expect(mock.calls.refresh).toBe(0)
      expect(isExpiring(record, record.obtained_at + 10_000)).toBe(false)
      expect(isExpiring(record, record.obtained_at + 20_000)).toBe(true)
      await session({ now: () => record.obtained_at + 20_000 }).accessToken()
      expect(mock.calls.refresh).toBe(1)
    })

    it('treats a token obtained moments ago as fresh, even with expires_in 0', async () => {
      const now = Date.now()
      const record = { obtained_at: now, expires_at: now } as McpOAuthRecord
      expect(isExpiring(record, now + 1_000)).toBe(false)
    })
  })

  describe('credentials echoed in tool results (review #4)', () => {
    it('masks the hub-held token in text, structured content and error results', async () => {
      await startMock({ echoAuthTools: true })
      await login()
      const config = HubConfigSchema.parse({ servers: { hosted: { url: mock.mcpUrl, auth: 'oauth' } } })
      const h = new McpHub({
        config,
        resolveSecret: () => null,
        pins: new ToolPinStore(join(dir, 'pins.json')),
        oauth: (server, url) => new McpOAuthSession({ server, serverUrl: url, store, lockPath: null }),
      })
      hubs.push(h)
      const token = mock.issued.access[0]!
      for (const name of ['hosted__whoami', 'hosted__whoami_error']) {
        const resolution = await h.resolveCall(name, {})
        if (resolution?.kind !== 'tool') throw new Error(`expected ${name}`)
        const { result, stats } = await h.call(resolution.tool, resolution.args)
        const text = JSON.stringify(result)
        expect(text).not.toContain(token)
        expect(text).toContain('[REDACTED credential]')
        expect(stats.redactions).toBeGreaterThanOrEqual(2)
      }
    })

    it('scrubKnownValues leaves short values and unrelated text alone', () => {
      const { value, count } = scrubKnownValues({ a: 'port 5432, key abcdefgh12' }, ['5432', 'abcdefgh12'])
      expect(value.a).toBe('port 5432, key [REDACTED credential]')
      expect(count).toBe(1)
    })
  })

  describe('redirects with a bearer token (review #5)', () => {
    it('refuses a same-origin 307 instead of following it with the token', async () => {
      await login()
      await expect(session().fetch(`${mock.base}/redirect-same`)).rejects.toThrow(/redirect \(HTTP 307\)/)
      expect(mock.bearerSeen).toHaveLength(0)
    })

    it('refuses a cross-origin 307, so the token never reaches the other origin', async () => {
      await login()
      const other = await bystander()
      const target = `${mock.base}/redirect-cross?to=${encodeURIComponent(other.url)}`
      await expect(session().fetch(target)).rejects.toThrow(/redirect/)
      expect(other.seen).toHaveLength(0)
    })
  })

  describe('login hardening (review #6, #8)', () => {
    it('checks the authorization server URL before fetching its metadata', async () => {
      await startMock({ authorizationServers: ['http://as.example.com'] })
      const requested: string[] = []
      const spy = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        requested.push(String(url))
        return fetch(url, init)
      }
      await expect(login({ fetchFn: spy })).rejects.toThrow(/non-https/)
      expect(requested.some((u) => u.includes('as.example.com'))).toBe(false)
    })

    it('requests exactly the scope asked for, and none by default', async () => {
      await login({ scope: 'read:issues' })
      expect(mock.authorizeParams[0]!.get('scope')).toBe('read:issues')
    })

    it('sends the RFC 8707 resource even without protected-resource metadata', async () => {
      await startMock({ withoutResourceMetadata: true })
      await login()
      expect(mock.authorizeParams[0]!.get('resource')).toBe(mock.mcpUrl)
    })

    it('refuses metadata whose issuer is not the authorization server (RFC 8414 §3.3)', async () => {
      await startMock({ issuer: 'https://evil.example' })
      await expect(login()).rejects.toThrow(/names issuer https:\/\/evil\.example/)
      expect(mock.calls.register).toBe(0)
    })

    it('requires iss on the callback when the server advertises it (RFC 9207)', async () => {
      await startMock({ omitIssOnCallback: true })
      await expect(login()).rejects.toThrow(/missing the `iss` parameter/)
      expect(mock.calls.token).toBe(0)
    })

    it('re-checks the stored token endpoint before a refresh', async () => {
      const record = await login()
      saveMcpOAuthRecord(store, {
        ...record,
        metadata: { ...record.metadata, token_endpoint: 'http://as.example.com/token' },
      })
      await expect(session({ now: () => Date.now() + TWO_HOURS }).accessToken()).rejects.toThrow(
        /non-https token endpoint/,
      )
      expect(mock.calls.refresh).toBe(0)
    })
  })
})
