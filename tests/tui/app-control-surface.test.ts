import React from 'react'
import { render } from 'ink-testing-library'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import { ControlChannel } from '../../src/core/control-channel.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { ForemanCommandRouter, registerBuiltinCommands } from '../../src/core/foreman-command.js'
import { InboxRecorder, InboxService } from '../../src/core/inbox.js'
import { RegistryService } from '../../src/core/registry.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { App } from '../../src/tui/app.js'

// =============================================================================
// The TUI as a control surface (#612 / #613 / #614), driven with real
// keystrokes: queued approvals, the command console and the inbox.
// =============================================================================

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))
const RIGHT = '\u001B[C'
const ESC = '\u001B'

const approval = (requestId: string, sourceAgent: string, targetTool: string, deadlineMs: number): ApprovalRequest => ({
  requestId,
  sourceAgent,
  targetTool,
  args: { path: '.env' },
  riskScore: 70,
  riskReasons: ['secret_path'],
  riskFactors: [],
  riskBucket: 'high',
  llmVerification: null,
  securityReport: null,
  deadlineMs,
})

describe('TUI control surface', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let recorder: InboxRecorder
  let resolved: ForemanEventMap['approval:resolved'][]
  let app: ReturnType<typeof render>
  let channel: ControlChannel

  let registry: RegistryService
  let inbox: InboxService
  let router: ForemanCommandRouter

  const mount = async (
    extra: { keySettleMs?: number; pendingApprovals?: () => ApprovalRequest[] } = { keySettleMs: 0 },
  ): Promise<void> => {
    app = render(
      React.createElement(App, {
        bootInfo: {
          publicKey: Buffer.alloc(32, 1),
          policyRules: 3,
          dbPath: ':memory:',
          gateway: { stdio: true },
          version: '0.0.0-test',
        },
        services: {
          db,
          sqlite,
          bus,
          registry,
          inbox,
          ...extra,
          commandRouter: router,
          commandContext: {
            db,
            registry,
            llmConfigPath: '/nonexistent/llm.yaml',
            configDir: '/nonexistent',
            controlChannel: channel,
          },
        },
      }),
    )
    // Any key dismisses the boot splash.
    await tick()
    app.stdin.write(' ')
    await tick()
  }

  beforeEach(async () => {
    ;({ db, sqlite } = createInMemoryDb())
    bus = new EventBus<ForemanEventMap>()
    registry = new RegistryService(db, bus)
    registry.register({ id: 'codex', displayName: 'Codex', transport: 'stdio' })
    inbox = new InboxService(db, bus)
    recorder = new InboxRecorder(db, inbox, { bus, pollIntervalMs: 60_000 })
    recorder.start()
    router = new ForemanCommandRouter()
    registerBuiltinCommands(router)
    channel = new ControlChannel(db, bus)
    resolved = []
    bus.on('approval:resolved', (e) => resolved.push(e))
    await mount()
  })

  afterEach(() => {
    app.unmount()
    recorder.stop()
    sqlite.close()
  })

  it('queues concurrent approvals and applies each key to the one on screen', async () => {
    const now = Date.now()
    bus.emit('approval:requested', approval('r1', 'claude-code', 'read_file', now + 60_000))
    bus.emit('approval:requested', approval('r2', 'hermes', 'shell_exec', now + 90_000))
    await tick()
    expect(strip(app.lastFrame())).toContain('Approval 1 of 2')
    expect(strip(app.lastFrame())).toContain('2 waiting')

    app.stdin.write(RIGHT)
    await tick()
    expect(strip(app.lastFrame())).toContain('Approval 2 of 2')
    app.stdin.write('d')
    await tick()
    expect(resolved).toEqual([{ requestId: 'r2', decision: 'denied', resolvedBy: 'user', via: 'tui' }])
    expect(strip(app.lastFrame())).toContain('1 waiting')
    expect(strip(app.lastFrame())).not.toContain('Approval 1 of')

    // Decided elsewhere (Telegram, a timeout): the prompt just goes away.
    bus.emit('approval:resolved', { requestId: 'r1', decision: 'allowed', resolvedBy: 'agent', via: 'agent_mcp' })
    await tick()
    expect(strip(app.lastFrame())).toContain('nothing waiting')
  })

  it('q on the approval screen asks to quit and never decides the approval (#637)', async () => {
    bus.emit('approval:requested', approval('qq', 'codex', 'shell_exec', Date.now() + 60_000))
    await tick()
    expect(strip(app.lastFrame())).toContain('q quit')
    app.stdin.write('q')
    await tick()
    const frame = strip(app.lastFrame())
    expect(frame).toContain('Quit Foreman?')
    expect(frame).toContain('Waiting calls will be denied')
    // While the question is up, a/d don't reach the approval.
    app.stdin.write('a')
    await tick()
    expect(resolved).toEqual([])
    app.stdin.write('n')
    await tick()
    expect(strip(app.lastFrame())).not.toContain('Quit Foreman?')
    // Still on the approval, which still decides with its own keys.
    expect(strip(app.lastFrame())).toContain('shell_exec')
    expect(resolved).toEqual([])
    app.stdin.write('d')
    await tick()
    expect(resolved).toEqual([{ requestId: 'qq', decision: 'denied', resolvedBy: 'user', via: 'tui' }])
  })

  it('never auto-denies on its own clock', async () => {
    bus.emit('approval:requested', approval('r3', 'codex', 'write_file', Date.now() + 1_000))
    await tick(1_300)
    expect(resolved).toEqual([])
  })

  it('runs commands from the console: approve, write to an agent', async () => {
    bus.emit('approval:requested', approval('r4', 'codex', 'read_file', Date.now() + 60_000))
    await tick()
    app.stdin.write(':')
    await tick()
    expect(strip(app.lastFrame())).toContain('1 approval waiting')
    app.stdin.write('approve')
    await tick(20)
    app.stdin.write('\r')
    await tick()
    expect(resolved.map((r) => [r.requestId, r.decision])).toEqual([['r4', 'allowed']])

    app.stdin.write('write codex add a regression test')
    await tick(20)
    app.stdin.write('\r')
    await tick(150)
    const frame = strip(app.lastFrame())
    expect(frame).toContain('› write codex add a regression test')
    // The TUI is the owner at the host: no Telegram id needed.
    expect(channel.pending().map((r) => JSON.parse(r.args))).toEqual([['codex', 'add a regression test']])
  })

  it('shows what happened in the inbox, with an unread count in the header', async () => {
    bus.emit('approval:requested', approval('r5', 'codex', 'read_file', Date.now() + 60_000))
    bus.emit('approval:resolved', { requestId: 'r5', decision: 'denied', resolvedBy: 'timeout' })
    await tick()
    expect(strip(app.lastFrame())).toContain('1 new')
    app.stdin.write('n')
    await tick()
    const frame = strip(app.lastFrame())
    expect(frame).toContain('Inbox')
    expect(frame).toContain('Denied read_file for codex')
    app.stdin.write('R')
    await tick()
    expect(strip(app.lastFrame())).toContain('all caught up')
    app.stdin.write(ESC)
    await tick()
    expect(strip(app.lastFrame())).toContain('Activity')
  })

  it('opens on a splash that any key dismisses', async () => {
    expect(strip(app.lastFrame())).toContain('FOREMAN')
    expect(strip(app.lastFrame())).toContain('Activity')
  })

  it('cycles pages with Tab', async () => {
    app.stdin.write('\t')
    await tick()
    expect(strip(app.lastFrame())).toContain('all caught up')
  })

  it('shows approvals that were already waiting when it started', async () => {
    app.unmount()
    await mount({ keySettleMs: 0, pendingApprovals: () => [approval('r0', 'hermes', 'shell_exec', Date.now() + 60_000)] })
    expect(strip(app.lastFrame())).toContain('[a]llow once')
    expect(strip(app.lastFrame())).toContain('hermes')
  })
})

describe('TUI key settle guard', () => {
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
        bootInfo: {
          publicKey: Buffer.alloc(32, 1),
          policyRules: 3,
          dbPath: ':memory:',
          gateway: { stdio: true },
          version: '0.0.0-test',
        },
        services: { db, sqlite, bus, registry, inbox: new InboxService(db, bus), keySettleMs: 300 },
      }),
    )
    await tick()
    app.stdin.write(' ')
    await tick(350)
  })

  afterEach(() => {
    app.unmount()
    sqlite.close()
  })

  it('a repeated key never decides the next approval in the queue', async () => {
    const now = Date.now()
    // Medium risk: one key decides (high and critical take a second key, #656).
    const medium = (r: ApprovalRequest): ApprovalRequest => ({ ...r, riskBucket: 'medium', riskScore: 40 })
    bus.emit('approval:requested', medium(approval('q1', 'codex', 'shell_exec', now + 60_000)))
    bus.emit('approval:requested', medium(approval('q2', 'hermes', 'write_file', now + 70_000)))
    bus.emit('approval:requested', medium(approval('q3', 'claude-code', 'read_file', now + 80_000)))
    await tick(350)
    // A triple tap of "always allow".
    app.stdin.write('A')
    await tick(5)
    app.stdin.write('A')
    await tick(5)
    app.stdin.write('A')
    await tick(60)
    expect(resolved.map((r) => [r.requestId, r.remember])).toEqual([['q1', 'allow']])
    expect(strip(app.lastFrame())).toContain('Approval 1 of 2')
    // Once the screen has been still for a moment, keys work again.
    await tick(350)
    app.stdin.write('d')
    await tick(60)
    expect(resolved.map((r) => r.requestId)).toEqual(['q1', 'q2'])
  })

  it('a key meant for an approval that just vanished does not reach the page', async () => {
    bus.emit('approval:requested', approval('q4', 'codex', 'shell_exec', Date.now() + 60_000))
    await tick(350)
    // Decided on Telegram a moment before the user pressed a key.
    bus.emit('approval:resolved', { requestId: 'q4', decision: 'allowed', resolvedBy: 'agent', via: 'agent_mcp' })
    await tick(20)
    app.stdin.write('n')
    await tick(60)
    expect(strip(app.lastFrame())).not.toContain('Inbox ·')
    expect(strip(app.lastFrame())).toContain('Activity')
    await tick(350)
    app.stdin.write('n')
    await tick(60)
    expect(strip(app.lastFrame())).toContain('all caught up')
  })
})
