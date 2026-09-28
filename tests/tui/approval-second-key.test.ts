import React from 'react'
import { render } from 'ink-testing-library'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { InboxService } from '../../src/core/inbox.js'
import { RegistryService } from '../../src/core/registry.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { App } from '../../src/tui/app.js'

// #656 (M12): one stray key must not allow a high- or critical-risk call,
// page hotkeys stay off while an approval is on screen, and a long
// request fits a small terminal without pushing the header away.

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

const request = (requestId: string, bucket: ApprovalRequest['riskBucket'], args: unknown = { cmd: 'rm -rf /' }): ApprovalRequest => ({
  requestId,
  sourceAgent: 'claude-code',
  targetTool: 'shell_exec',
  args,
  riskScore: bucket === 'critical' ? 100 : bucket === 'high' ? 70 : 20,
  riskReasons: ['shell_destructive'],
  riskFactors: [],
  riskBucket: bucket,
  llmVerification: null,
  securityReport: null,
  deadlineMs: Date.now() + 60_000,
})

describe('allowing a risky call takes a second key (#656)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let app: ReturnType<typeof render>
  let resolved: ForemanEventMap['approval:resolved'][]

  beforeEach(async () => {
    ;({ db, sqlite } = createInMemoryDb())
    bus = new EventBus<ForemanEventMap>()
    const registry = new RegistryService(db, bus)
    resolved = []
    bus.on('approval:resolved', (e) => resolved.push(e))
    app = render(
      React.createElement(App, {
        bootInfo: { publicKey: Buffer.alloc(32, 1), policyRules: 3, dbPath: ':memory:', gateway: { stdio: true }, version: '0.0.0-test' },
        services: { db, sqlite, bus, registry, inbox: new InboxService(db, bus), keySettleMs: 0 },
      }),
    )
    await tick()
    app.stdin.write(' ')
    await tick()
  })
  afterEach(() => {
    app.unmount()
    sqlite.close()
  })

  it.each([['critical'], ['high']] as const)('%s: `a` asks, `y` allows', async (bucket) => {
    bus.emit('approval:requested', request('r1', bucket))
    await tick()
    app.stdin.write('a')
    await tick()
    expect(resolved).toEqual([])
    expect(strip(app.lastFrame())).toContain(`Allow this ${bucket.toUpperCase()}-risk call`)
    // A second stray `a` does nothing either.
    app.stdin.write('a')
    await tick()
    expect(resolved).toEqual([])
    app.stdin.write('y')
    await tick()
    expect(resolved).toEqual([expect.objectContaining({ requestId: 'r1', decision: 'allowed' })])
  })

  it('`A` on a critical call asks too, and `n` goes back without deciding', async () => {
    bus.emit('approval:requested', request('r2', 'critical'))
    await tick()
    app.stdin.write('A')
    await tick()
    expect(strip(app.lastFrame())).toContain('Always allow this CRITICAL-risk call')
    app.stdin.write('n')
    await tick()
    expect(resolved).toEqual([])
    app.stdin.write('d')
    await tick()
    expect(resolved).toEqual([expect.objectContaining({ requestId: 'r2', decision: 'denied' })])
  })

  it('from the inspector too', async () => {
    bus.emit('approval:requested', request('r3', 'critical'))
    await tick()
    app.stdin.write('i')
    await tick()
    app.stdin.write('a')
    await tick()
    expect(resolved).toEqual([])
    app.stdin.write('y')
    await tick()
    expect(resolved).toEqual([expect.objectContaining({ requestId: 'r3', decision: 'allowed' })])
  })

  it('low and medium still take one key', async () => {
    bus.emit('approval:requested', request('r4', 'medium', { cmd: 'ls' }))
    await tick()
    app.stdin.write('a')
    await tick()
    expect(resolved).toEqual([expect.objectContaining({ requestId: 'r4', decision: 'allowed' })])
  })

  it('page hotkeys do nothing while an approval is on screen', async () => {
    bus.emit('approval:requested', request('r5', 'medium', { cmd: 'ls' }))
    await tick()
    for (const key of ['l', 'p', 'k', 's', 'x', 'r', 'e', '\t', 'n']) {
      app.stdin.write(key)
      await tick(20)
    }
    expect(resolved).toEqual([])
    app.stdin.write('d')
    await tick()
    expect(resolved).toEqual([expect.objectContaining({ requestId: 'r5', decision: 'denied' })])
    // Still on the dashboard: none of those keys switched pages.
    expect(strip(app.lastFrame())).toContain('Activity')
  })

  it('a long request fits a 24-row terminal: header, keys and timer stay on screen', async () => {
    const long = { path: `/tmp/${'very-long-directory-name/'.repeat(40)}secret.env` }
    bus.emit('approval:requested', {
      ...request('r6', 'high', long),
      targetTool: 'read_file',
      riskFactors: Array.from({ length: 12 }, (_, i) => ({
        rule: `factor_${i}`,
        category: 'secret' as const,
        points: 5,
        reason: `reason number ${i} that is fairly long so it wraps on a narrow terminal window`,
      })),
    })
    bus.emit('approval:requested', request('r7', 'medium', { cmd: 'ls' }))
    await tick()
    const frame = strip(app.lastFrame())
    const lines = frame.split('\n')
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(frame).toContain('Approval 1 of 2')
    expect(frame).toMatch(/llow once/)
    expect(frame).toMatch(/s left/)
    // The header (first line of the app) is still the first thing shown.
    expect(lines.slice(0, 3).join('\n')).toMatch(/foreman|Foreman|FOREMAN/)
  })
})
