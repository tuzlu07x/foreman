import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import {
  AgentNotFoundError,
  RegistryService,
} from '../../src/core/registry.js'
import { generateKeypair } from '../../src/identity/keypair.js'
import { sign } from '../../src/identity/signing.js'

describe('RegistryService', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let registry: RegistryService

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    registry = new RegistryService(db, bus)
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('register', () => {
    it('generates a keypair when none is provided and emits agent:registered', () => {
      const handler = vi.fn()
      bus.on('agent:registered', handler)
      const result = registry.register({
        id: 'hermes',
        displayName: 'Hermes',
        transport: 'stdio',
      })
      expect(result.privateKey).toHaveLength(32)
      expect(result.agent.id).toBe('hermes')
      expect(result.agent.status).toBe('active')
      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'hermes', transport: 'stdio' }),
      )
    })

    it('uses the caller-provided public key and returns no private key', () => {
      const kp = generateKeypair()
      const result = registry.register({
        id: 'claude-code',
        displayName: 'Claude Code',
        transport: 'stdio',
        publicKey: kp.publicKey,
      })
      expect(result.privateKey).toBeUndefined()
      const ok = registry.authenticate(
        'claude-code',
        'hello',
        sign('hello', kp.privateKey),
      )
      expect(ok).toBe(true)
    })

    it('throws when registering the same id twice', () => {
      registry.register({ id: 'a', displayName: 'A', transport: 'stdio' })
      expect(() =>
        registry.register({ id: 'a', displayName: 'A', transport: 'stdio' }),
      ).toThrow()
    })

    it('persists metadata round-trip as JSON', () => {
      registry.register({
        id: 'custom',
        displayName: 'Custom',
        transport: 'stdio',
        metadata: { version: '1.2.3', capabilities: ['fs', 'shell'] },
      })
      const agent = registry.get('custom')
      expect(agent?.metadata).toEqual({
        version: '1.2.3',
        capabilities: ['fs', 'shell'],
      })
    })
  })

  describe('authenticate', () => {
    it('returns true for a valid signature', () => {
      const { privateKey } = registry.register({
        id: 'hermes',
        displayName: 'Hermes',
        transport: 'stdio',
      })
      const sig = sign('approve req_1', privateKey!)
      expect(registry.authenticate('hermes', 'approve req_1', sig)).toBe(true)
    })

    it('returns false for a tampered message', () => {
      const { privateKey } = registry.register({
        id: 'hermes',
        displayName: 'Hermes',
        transport: 'stdio',
      })
      const sig = sign('approve req_1', privateKey!)
      expect(registry.authenticate('hermes', 'approve req_2', sig)).toBe(false)
    })

    it('returns false for an unknown agent', () => {
      expect(registry.authenticate('ghost', 'msg', Buffer.alloc(64))).toBe(false)
    })

    it('returns false for a blocked agent even with a valid signature', () => {
      const { privateKey } = registry.register({
        id: 'hermes',
        displayName: 'Hermes',
        transport: 'stdio',
      })
      const sig = sign('hi', privateKey!)
      registry.block('hermes')
      expect(registry.authenticate('hermes', 'hi', sig)).toBe(false)
    })
  })

  describe('list', () => {
    it('returns active and inactive agents but excludes blocked ones', () => {
      registry.register({ id: 'a', displayName: 'A', transport: 'stdio' })
      registry.register({ id: 'b', displayName: 'B', transport: 'stdio' })
      registry.register({ id: 'c', displayName: 'C', transport: 'stdio' })
      registry.block('b')
      const ids = registry.list().map((a) => a.id).sort()
      expect(ids).toEqual(['a', 'c'])
    })
  })

  describe('heartbeat', () => {
    it('bumps last_seen_at, flips status to active, emits agent:heartbeat', () => {
      registry.register({ id: 'a', displayName: 'A', transport: 'stdio' })
      const handler = vi.fn()
      bus.on('agent:heartbeat', handler)
      registry.heartbeat('a')
      const agent = registry.get('a')
      expect(agent?.lastSeenAt).toBeGreaterThan(0)
      expect(agent?.status).toBe('active')
      expect(handler).toHaveBeenCalledOnce()
    })

    it('throws AgentNotFoundError for an unknown agent', () => {
      expect(() => registry.heartbeat('ghost')).toThrow(AgentNotFoundError)
    })

    it('throws AgentNotFoundError for a blocked agent', () => {
      registry.register({ id: 'a', displayName: 'A', transport: 'stdio' })
      registry.block('a')
      expect(() => registry.heartbeat('a')).toThrow(AgentNotFoundError)
    })
  })

  describe('block / unblock', () => {
    it('block removes the agent from list(), unblock restores it', () => {
      registry.register({ id: 'a', displayName: 'A', transport: 'stdio' })
      registry.block('a')
      expect(registry.list().map((x) => x.id)).not.toContain('a')
      registry.unblock('a')
      expect(registry.list().map((x) => x.id)).toContain('a')
    })

    it('throws for unknown agent on both block and unblock', () => {
      expect(() => registry.block('ghost')).toThrow(AgentNotFoundError)
      expect(() => registry.unblock('ghost')).toThrow(AgentNotFoundError)
    })
  })

  // #524 — Free-form chat invocation. Foreman's command router calls
  // this from its unknown-verb fallback to decide whether "OpenClaw, foo"
  // should route to `write openclaw "foo"` or fall through to the LLM.
  describe('findByCommandToken (#524)', () => {
    it('matches an active agent by exact (case-folded) id', () => {
      registry.register({ id: 'openclaw', displayName: 'OpenClaw', transport: 'stdio' })
      const result = registry.findByCommandToken('OPENCLAW')
      expect(result.kind).toBe('match')
      if (result.kind === 'match') expect(result.agent.id).toBe('openclaw')
    })

    it('matches by displayName when id and displayName diverge', () => {
      registry.register({ id: 'oc', displayName: 'OpenClaw', transport: 'stdio' })
      const result = registry.findByCommandToken('openclaw')
      expect(result.kind).toBe('match')
      if (result.kind === 'match') expect(result.agent.id).toBe('oc')
    })

    it('returns none for an unknown token', () => {
      registry.register({ id: 'openclaw', displayName: 'OpenClaw', transport: 'stdio' })
      expect(registry.findByCommandToken('supernova').kind).toBe('none')
    })

    it('returns none for an empty / whitespace-only token', () => {
      expect(registry.findByCommandToken('').kind).toBe('none')
      expect(registry.findByCommandToken('   ').kind).toBe('none')
    })

    it('does NOT substring-match — "Code" must not hit "claude-code"', () => {
      // The substring footgun the issue body calls out explicitly.
      // Surprise routing is worse than "unknown command".
      registry.register({ id: 'claude-code', displayName: 'Claude Code', transport: 'stdio' })
      expect(registry.findByCommandToken('code').kind).toBe('none')
      expect(registry.findByCommandToken('claude').kind).toBe('none')
    })

    it('returns ambiguous when two active agents share a case-folded displayName', () => {
      registry.register({ id: 'code-a', displayName: 'Code', transport: 'stdio' })
      registry.register({ id: 'code-b', displayName: 'Code', transport: 'stdio' })
      const result = registry.findByCommandToken('code')
      expect(result.kind).toBe('ambiguous')
      if (result.kind === 'ambiguous') {
        expect(result.candidates.sort()).toEqual(['code-a', 'code-b'])
      }
    })

    it('skips blocked agents (none result, not match)', () => {
      registry.register({ id: 'openclaw', displayName: 'OpenClaw', transport: 'stdio' })
      registry.block('openclaw')
      expect(registry.findByCommandToken('openclaw').kind).toBe('none')
    })
  })
})
