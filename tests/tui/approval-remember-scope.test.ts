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

// #656 (M6): "deny always" says what it will remember and waits for `y`.

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Wait until `check` holds, then let the render settle: Ink attaches the
 *  new key handler in an effect after the frame is written, so a key sent
 *  in between would reach the previous screen's handler. */
const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await tick(20)
  await tick(100)
}
const ESC = String.fromCharCode(27)

const request = (requestId: string, bucket: ApprovalRequest['riskBucket'] = 'medium'): ApprovalRequest => ({
  requestId,
  sourceAgent: 'qa-bot',
  targetTool: 'read_file',
  args: { path: '/home/u/.ssh/id_rsa' },
  riskScore: 40,
  riskReasons: ['secret_path'],
  riskFactors: [],
  riskBucket: bucket,
  llmVerification: null,
  securityReport: null,
  deadlineMs: Date.now() + 60_000,
})

describe('approval modal: what "always" remembers (#656)', () => {
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

  it('shows the scope next to the keys, and D waits for y', async () => {
    bus.emit('approval:requested', request('m6'))
    await until(() => strip(app.lastFrame()).includes('remembers:'))
    expect(strip(app.lastFrame())).toContain('remembers: qa-bot → read_file, only for "/home/u/.ssh/id_rsa"')
    app.stdin.write('D')
    await until(() => strip(app.lastFrame()).includes('Deny always:'))
    const asking = strip(app.lastFrame())
    expect(asking).toContain('Deny always: qa-bot → read_file, only for "/home/u/.ssh/id_rsa"?')
    expect(asking).toContain('[y] yes')
    expect(resolved).toEqual([])
    // Anything but y / n is ignored; n goes back to the keys.
    app.stdin.write('a')
    await tick()
    expect(resolved).toEqual([])
    app.stdin.write('n')
    await until(() => !strip(app.lastFrame()).includes('Deny always:'))
    expect(strip(app.lastFrame())).toContain('eny always')
    expect(strip(app.lastFrame())).not.toContain('Deny always:')
    app.stdin.write('D')
    await until(() => strip(app.lastFrame()).includes('Deny always:'))
    app.stdin.write(ESC)
    await until(() => !strip(app.lastFrame()).includes('Deny always:'))
    expect(resolved).toEqual([])
    app.stdin.write('D')
    await until(() => strip(app.lastFrame()).includes('Deny always:'))
    app.stdin.write('y')
    await until(() => resolved.length > 0)
    expect(resolved).toEqual([expect.objectContaining({ requestId: 'm6', decision: 'denied', remember: 'deny' })])
  })
})
