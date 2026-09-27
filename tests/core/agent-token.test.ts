import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentTokenSecretName,
  agentTokensEqual,
  ensureAgentToken,
  findAgentByToken,
  hasAgentToken,
  InvalidTokenAgentIdError,
  issueAgentToken,
  mintAgentToken,
  recheckAgentIdentity,
  resolveAgentIdentity,
  revokeAgentToken,
  takeAgentToken,
  verifyAgentToken,
} from '../../src/core/agent-token.js'
import { claimedAgentOf, isUntrustedSource, untrustedSource } from '../../src/core/agent-identity.js'
import { redactSecretShapes, secretPatternRule } from '../../src/core/risk-rules/secret-patterns.js'
import type { RiskContext } from '../../src/core/risk-rules/types.js'
import { ReservedSecretError, SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { generateMasterKey } from '../../src/identity/encryption.js'

// Per-agent identity tokens (#618): minting, storage, verification and how
// an MCP connection's identity is resolved from `--source` + the token.

describe('agent tokens', () => {
  let sqlite: Database.Database
  let store: SecretStore

  beforeEach(() => {
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, generateMasterKey())
  })
  afterEach(() => {
    sqlite.close()
  })

  it('mints distinct, prefixed, base64url tokens with 256 bits of entropy', () => {
    const a = mintAgentToken()
    const b = mintAgentToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^fat_[A-Za-z0-9_-]{43}$/)
  })

  it('stores the token encrypted under a reserved name nothing generic can read or overwrite', () => {
    const token = issueAgentToken(store, 'codex')
    const name = agentTokenSecretName('codex')
    expect(hasAgentToken(store, 'codex')).toBe(true)
    const row = sqlite.prepare('SELECT value_encrypted FROM secrets WHERE name = ?').get(name) as {
      value_encrypted: Buffer
    }
    expect(row.value_encrypted.toString('utf8')).not.toContain(token)
    expect(() => store.get(name)).toThrow(ReservedSecretError)
    expect(() => store.rotate(name, 'fat_mine')).toThrow(ReservedSecretError)
    expect(() => store.add(`${name}-x`, 'v')).toThrow(ReservedSecretError)
    // Unreadable through the generic API, the token still verifies.
    expect(verifyAgentToken(store, 'codex', token)).toBe(true)
  })

  it('ensure keeps the current token; issue replaces it and the old one stops working', () => {
    const first = ensureAgentToken(store, 'codex')
    expect(ensureAgentToken(store, 'codex')).toBe(first)
    const second = issueAgentToken(store, 'codex')
    expect(second).not.toBe(first)
    expect(verifyAgentToken(store, 'codex', first)).toBe(false)
    expect(verifyAgentToken(store, 'codex', second)).toBe(true)
  })

  it('revoking removes the token', () => {
    const token = issueAgentToken(store, 'codex')
    expect(revokeAgentToken(store, 'codex')).toBe(true)
    expect(verifyAgentToken(store, 'codex', token)).toBe(false)
    expect(revokeAgentToken(store, 'codex')).toBe(false)
  })

  it("refuses to mint for your own ids or the untrusted namespace", () => {
    for (const id of ['cli', 'TUI', 'telegram', 'untrusted:codex', '', ' codex']) {
      expect(() => issueAgentToken(store, id)).toThrow(InvalidTokenAgentIdError)
    }
  })

  it('compares tokens exactly', () => {
    const t = mintAgentToken()
    expect(agentTokensEqual(t, t)).toBe(true)
    expect(agentTokensEqual(t, `${t}x`)).toBe(false)
    expect(agentTokensEqual(t, t.slice(0, -1))).toBe(false)
    expect(agentTokensEqual('', '')).toBe(false)
  })

  it('finds the owner of a token among all agents', () => {
    const codex = issueAgentToken(store, 'codex')
    const claude = issueAgentToken(store, 'claude-code')
    store.add('anthropic-key', codex) // a normal secret with the same value is not a token
    expect(findAgentByToken(store, codex)).toBe('codex')
    expect(findAgentByToken(store, claude)).toBe('claude-code')
    expect(findAgentByToken(store, mintAgentToken())).toBeNull()
    expect(findAgentByToken(store, '')).toBeNull()
  })

  describe('resolveAgentIdentity', () => {
    let codex: string
    let claude: string
    beforeEach(() => {
      codex = issueAgentToken(store, 'codex')
      claude = issueAgentToken(store, 'claude-code')
    })

    it('trusts --source only with that agent’s token', () => {
      expect(resolveAgentIdentity({ claimed: 'codex', token: codex, store })).toEqual({
        source: 'codex',
        claimed: 'codex',
        trusted: true,
        reason: 'token',
      })
    })

    it('resolves the agent from the token alone', () => {
      expect(resolveAgentIdentity({ token: claude, store })).toMatchObject({ source: 'claude-code', trusted: true })
    })

    it('a spoofed --source without a token is untrusted:<claimed>', () => {
      expect(resolveAgentIdentity({ claimed: 'codex', store })).toEqual({
        source: 'untrusted:codex',
        claimed: 'codex',
        trusted: false,
        reason: 'no-token',
      })
      expect(resolveAgentIdentity({ claimed: 'codex', token: '  ', store }).reason).toBe('no-token')
    })

    it("a wrong token, or another agent's token, never grants the claimed id", () => {
      expect(resolveAgentIdentity({ claimed: 'codex', token: mintAgentToken(), store })).toMatchObject({
        source: 'untrusted:codex',
        reason: 'invalid-token',
      })
      expect(resolveAgentIdentity({ claimed: 'codex', token: claude, store })).toMatchObject({
        source: 'untrusted:codex',
        reason: 'token-mismatch',
      })
      expect(resolveAgentIdentity({ claimed: 'Codex', token: codex, store }).trusted).toBe(false)
    })

    it('no --source and no token is untrusted:mcp-client', () => {
      expect(resolveAgentIdentity({ store }).source).toBe('untrusted:mcp-client')
    })

    it('a rotated token drops a running session to untrusted, and it stays there', () => {
      const identity = resolveAgentIdentity({ claimed: 'codex', token: codex, store })
      expect(recheckAgentIdentity(identity, codex, store)).toBe(identity)
      issueAgentToken(store, 'codex')
      const dropped = recheckAgentIdentity(identity, codex, store)
      expect(dropped).toMatchObject({ source: 'untrusted:codex', trusted: false, reason: 'invalid-token' })
      expect(recheckAgentIdentity(dropped, codex, store)).toBe(dropped)
    })

    it('a removed agent loses its identity too', () => {
      const identity = resolveAgentIdentity({ claimed: 'codex', token: codex, store })
      revokeAgentToken(store, 'codex')
      expect(recheckAgentIdentity(identity, codex, store).trusted).toBe(false)
    })
  })

  it('a leaked token is flagged in call args and redacted from text', () => {
    const token = mintAgentToken()
    const out = redactSecretShapes(`export FOREMAN_AGENT_TOKEN='${token}'`)
    expect(out.text).toBe("export FOREMAN_AGENT_TOKEN='[REDACTED Foreman agent token]'")
    const ctx = { db: null as never } as RiskContext
    const factors = secretPatternRule.evaluate({ sourceAgent: 'codex', targetTool: 'http_post', args: { body: token } }, ctx)
    expect(factors.map((f) => f.reason).join(' ')).toContain('Foreman agent token')
  })

  describe('taking the token from the environment', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'foreman-token-intake-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('removes both variables so nothing spawned later inherits them', () => {
      const env: NodeJS.ProcessEnv = { FOREMAN_AGENT_TOKEN: 'fat_a', FOREMAN_AGENT_TOKEN_FILE: '/nope', PATH: '/bin' }
      expect(takeAgentToken(env)).toEqual({ token: 'fat_a' })
      expect(env).toEqual({ PATH: '/bin' })
    })

    it('trims once, so a trailing newline stays trusted after connecting', () => {
      const codex = issueAgentToken(store, 'codex')
      const { token } = takeAgentToken({ FOREMAN_AGENT_TOKEN: `  ${codex}\n` })
      const identity = resolveAgentIdentity({ claimed: 'codex', token, store })
      expect(identity.trusted).toBe(true)
      expect(recheckAgentIdentity(identity, token!, store)).toBe(identity)
      expect(takeAgentToken({ FOREMAN_AGENT_TOKEN: ' \n' })).toEqual({ token: undefined })
    })

    it('reads FOREMAN_AGENT_TOKEN_FILE only from an owner-only regular file', () => {
      const file = join(dir, 'tok')
      writeFileSync(file, 'fat_from_file\n', { mode: 0o600 })
      expect(takeAgentToken({ FOREMAN_AGENT_TOKEN_FILE: file })).toEqual({ token: 'fat_from_file' })
      chmodSync(file, 0o644)
      expect(takeAgentToken({ FOREMAN_AGENT_TOKEN_FILE: file }).token).toBeUndefined()
      chmodSync(file, 0o600)
      symlinkSync(file, join(dir, 'link'))
      expect(takeAgentToken({ FOREMAN_AGENT_TOKEN_FILE: join(dir, 'link') }).problem).toMatch(/regular file/)
      expect(takeAgentToken({ FOREMAN_AGENT_TOKEN_FILE: join(dir, 'missing') }).problem).toMatch(/can't be read/)
      // The env var wins over the file.
      expect(takeAgentToken({ FOREMAN_AGENT_TOKEN: 'fat_env', FOREMAN_AGENT_TOKEN_FILE: file }).token).toBe('fat_env')
    })
  })

  it('a failing store means untrusted, never a crash or trust', () => {
    const broken = {
      exists: () => {
        throw new Error('database is locked')
      },
      list: () => {
        throw new Error('database is locked')
      },
    } as unknown as SecretStore
    expect(verifyAgentToken(broken, 'codex', 'fat_x')).toBe(false)
    expect(resolveAgentIdentity({ claimed: 'codex', token: 'fat_x', store: broken })).toMatchObject({
      trusted: false,
      source: 'untrusted:codex',
    })
  })

  it('untrusted ids round-trip to the claimed agent', () => {
    expect(untrustedSource('codex')).toBe('untrusted:codex')
    expect(untrustedSource('untrusted:codex')).toBe('untrusted:codex')
    expect(isUntrustedSource('Untrusted:codex')).toBe(true)
    expect(isUntrustedSource('codex')).toBe(false)
    expect(claimedAgentOf('untrusted:codex')).toBe('codex')
    expect(claimedAgentOf('codex')).toBe('codex')
  })
})
