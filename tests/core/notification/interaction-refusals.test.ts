import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { approvalSigner } from '../../../src/core/approval-token.js'
import { encodeApprovalButton } from '../../../src/core/notification/channels/approval-buttons.js'
import {
  describeRefusedButton,
  describeRefusedCommand,
  RefusalAuditLimiter,
  type InteractionRefusedEvent,
} from '../../../src/core/notification/interaction-refusals.js'

// Refused Slack / Discord interactions are audited, rate-limited so a
// flood from the workspace can't grow the audit log without bound.

const sign = approvalSigner(randomBytes(32))

const KNOWN = new Set(['status', 'help', 'integration'])

function limiter(opts: { globalPerWindow?: number } = {}) {
  let now = 1_000_000
  const written: InteractionRefusedEvent[] = []
  const l = new RefusalAuditLimiter((e) => written.push(e), {
    now: () => now,
    isKnownCommand: (v) => KNOWN.has(v),
    ...opts,
  })
  return {
    l,
    written,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('RefusalAuditLimiter', () => {
  it('writes one event per user per minute and says how many it skipped', () => {
    const { l, written, advance } = limiter()
    const tap = { platform: 'slack' as const, userId: 'U0STRANGER', attempted: 'button:allow' }
    expect(l.record(tap)).toBe(true)
    for (let i = 0; i < 500; i++) expect(l.record(tap)).toBe(false)
    expect(written).toHaveLength(1)
    advance(59_999)
    expect(l.record(tap)).toBe(false)
    advance(1)
    expect(l.record({ ...tap, attempted: 'command:status' })).toBe(true)
    expect(written).toEqual([
      { platform: 'slack', userId: 'U0STRANGER', attempted: 'button:allow' },
      { platform: 'slack', userId: 'U0STRANGER', attempted: 'command:status', suppressed: 501 },
    ])
  })

  it('limits users separately, and per platform', () => {
    const { l, written } = limiter()
    l.record({ platform: 'slack', userId: 'U1', attempted: 'button:allow' })
    l.record({ platform: 'slack', userId: 'U2', attempted: 'button:allow' })
    l.record({ platform: 'discord', userId: 'U1', attempted: 'button:allow' })
    l.record({ platform: 'slack', userId: 'U1', attempted: 'button:deny' })
    expect(written.map((e) => `${e.platform}:${e.userId}`)).toEqual(['slack:U1', 'slack:U2', 'discord:U1'])
  })

  it('caps the events per minute across all users, and counts what it skipped', () => {
    const { l, written, advance } = limiter({ globalPerWindow: 3 })
    for (let i = 0; i < 100; i++) l.record({ platform: 'discord', userId: `${100000 + i}`, attempted: 'interaction' })
    expect(written).toHaveLength(3)
    advance(60_000)
    l.record({ platform: 'discord', userId: '100050', attempted: 'interaction' })
    expect(written.at(-1)).toEqual({ platform: 'discord', userId: '100050', attempted: 'interaction', suppressed: 1 })
  })

  it('never copies an id that is not a plain platform id into the log', () => {
    const { l, written } = limiter()
    l.record({ platform: 'slack', userId: 'U1\u001b[31m\nfake line', attempted: 'button:allow' })
    l.record({ platform: 'slack', userId: '', attempted: 'button:allow' })
    expect(written).toEqual([{ platform: 'slack', userId: 'invalid', attempted: 'button:allow' }])
  })

  it('writes only verbs Foreman knows; any other first word is "command:other"', () => {
    const { l, written } = limiter()
    l.record({ platform: 'slack', userId: 'U1', attempted: describeRefusedCommand('integration disable github') })
    l.record({ platform: 'slack', userId: 'U2', attempted: describeRefusedCommand('sk-live-123 is my key') })
    l.record({ platform: 'slack', userId: 'U3', attempted: describeRefusedCommand('hunter2') })
    expect(written.map((e) => e.attempted)).toEqual(['command:integration', 'command:other', 'command:other'])
    expect(JSON.stringify(written)).not.toMatch(/sk-live|hunter2/)
  })

  it('knows no verbs unless told, so it fails closed', () => {
    const written: InteractionRefusedEvent[] = []
    new RefusalAuditLimiter((e) => written.push(e)).record({ platform: 'discord', userId: '123456', attempted: 'command:status' })
    expect(written[0]!.attempted).toBe('command:other')
  })
})

describe('describing a refused interaction', () => {
  it('keeps the approval id only for a button Foreman signed, and never the tag', () => {
    const genuine = encodeApprovalButton('req-1', 'allow_always', sign)
    expect(describeRefusedButton(genuine, sign)).toEqual({ attempted: 'button:allow_always', requestId: 'req-1' })
    expect(describeRefusedButton('fa:allow:req-1.forged', sign)).toEqual({ attempted: 'button:allow' })
    expect(describeRefusedButton('fa:rm_rf:req-1.x', sign)).toEqual({ attempted: 'button:unknown' })
    expect(describeRefusedButton('anything else', sign)).toEqual({ attempted: 'button:unknown' })
  })

  it('keeps only the first word of a command', () => {
    expect(describeRefusedCommand('write codex paste sk-live-123')).toBe('command:write')
    expect(describeRefusedCommand('  Integration disable github')).toBe('command:integration')
    expect(describeRefusedCommand('')).toBe('command:help')
    expect(describeRefusedCommand('sk-live-123')).toBe('command:sk-live-123')
    expect(describeRefusedCommand('$(rm -rf /)')).toBe('command:other')
  })
})
