import { EventEmitter } from 'node:events'
import React from 'react'
import { render as inkRender, type Instance } from 'ink'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { InboxService } from '../../src/core/inbox.js'
import { RegistryService } from '../../src/core/registry.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { type ControlCommand, controlCommands, type InboxItem, requests } from '../../src/db/schema.js'
import { App } from '../../src/tui/app.js'
import { summariseControlCommand } from '../../src/tui/components/activity-feed.js'
import { displayWidth } from '../../src/tui/format.js'
import { InboxPage } from '../../src/tui/pages/inbox-page.js'

// Finding 38: on a wide terminal the Activity page (Home) drew rows over
// each other — "id=6anager: why don't you share…". The page has a fixed
// height; with more rows than fit, Yoga shrank every two-line row to one
// line, so each row's second line landed on the next row's first. These
// tests mount the whole TUI at real terminal sizes, with agent text full
// of line breaks, tabs, escapes, emoji and CJK, and long paths.

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ESC = String.fromCodePoint(0x1b)

/** A terminal of `columns` × `rows` (ink-testing-library's is 100 × none). */
class Stdout extends EventEmitter {
  frames: string[] = []
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super()
  }
  write = (frame: string): void => {
    this.frames.push(frame)
  }
}

class Stdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write = (data: string): void => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const MESSAGE = `why don't you share\nthe plan 🎉 漢字 with the team?\r\tthanks ${ESC}[2K${ESC}[31mred`
const DEEP_PATH = `/srv/clients/${'very-long-folder-name/'.repeat(8)}漢字🎉/proj${ESC}[8m\r\n/.env`

function seed(db: ForemanDb, now: number): void {
  for (let i = 0; i < 12; i++) {
    db.insert(controlCommands)
      .values({
        command: 'write',
        args: JSON.stringify(['manager', `${MESSAGE} ${'more words '.repeat(i)}`]),
        sourceAgent: 'hermes',
        status: 'applied',
        createdAt: now - i * 2000,
        appliedAt: now - i * 2000 + 5,
      })
      .run()
    db.insert(requests)
      .values({
        id: `r${i}`,
        sourceAgent: 'claude-code',
        targetAgent: 'codex',
        targetTool: 'read_file',
        args: JSON.stringify({ path: DEEP_PATH }),
        riskScore: 10,
        riskReasons: '[]',
        riskBucket: 'low',
        decision: 'allowed',
        decidedBy: 'policy:1',
        durationMs: 3,
        createdAt: now - i * 2000 - 1000,
        decidedAt: now - i * 2000 - 1000,
      })
      .run()
  }
}

async function mountAt(cols: number, rows: number): Promise<() => string> {
  const { db, sqlite } = createInMemoryDb()
  const bus = new EventBus<ForemanEventMap>()
  const registry = new RegistryService(db, bus)
  registry.register({ id: 'claude-code', displayName: 'Claude Code', transport: 'stdio' })
  registry.register({ id: 'hermes', displayName: 'Hermes', transport: 'stdio' })
  seed(db, Date.now())
  const stdout = new Stdout(cols, rows)
  const stdin = new Stdin()
  const instance: Instance = inkRender(
    React.createElement(App, {
      bootInfo: {
        publicKey: Buffer.alloc(32, 1),
        policyRules: 3,
        dbPath: ':memory:',
        gateway: { stdio: true },
        version: '0.0.0-test',
      },
      services: { db, sqlite, bus, registry, inbox: new InboxService(db, bus), keySettleMs: 0 },
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: new Stdout(cols, rows) as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  cleanups.push(() => {
    instance.unmount()
    sqlite.close()
  })
  await tick()
  stdin.write(' ') // past the boot splash
  await tick(300) // and past the rows' fade-in
  return () => strip(stdout.frames.at(-1) ?? '')
}

const TIME = String.raw`(?:just now|\d+(?:s|m|h|d|mo|y) ago)`
// Wide layout: the feed is the middle column, so a row starts after a `│`.
const CONTROL_HEAD = new RegExp(String.raw`(?:^|│)\s*${TIME} · hermes write manager: why don't you share`)
const REQUEST_HEAD = new RegExp(String.raw`(?:^|│)\s*${TIME} · claude-code → codex read_file\("`)

describe.each([80, 120, 200, 300])('Home at %i columns', (cols) => {
  it('keeps every Activity row on its own lines, inside the terminal', async () => {
    const rows = 40
    const frame = (await mountAt(cols, rows))()
    const lines = frame.split('\n')

    // Nothing wider than the terminal, and nothing taller.
    for (const l of lines) expect(displayWidth(l), l).toBeLessThanOrEqual(cols)
    expect(lines.length).toBeLessThanOrEqual(rows)
    // Agent text can't move the cursor or start a line of its own.
    expect(frame).not.toContain('\r')
    expect(frame).not.toContain('\t')
    expect(frame).not.toContain(ESC)

    // Each row starts with its time and agent; none is drawn over another.
    const controlHeads = lines.filter((l) => l.includes('write manager:'))
    const requestHeads = lines.filter((l) => l.includes('read_file('))
    expect(controlHeads.length).toBeGreaterThan(2)
    expect(requestHeads.length).toBeGreaterThan(2)
    for (const l of controlHeads) expect(l).toMatch(CONTROL_HEAD)
    for (const l of requestHeads) expect(l).toMatch(REQUEST_HEAD)
    // The status line ends at its id: no other row's text glued on.
    const statusLines = lines.filter((l) => /· id=\d+/.test(l))
    expect(statusLines.length).toBeGreaterThan(2)
    for (const l of statusLines) expect(l).toMatch(/· id=\d+\s*│/)
    // A line break in a message shows as ⏎, and the long path keeps its file name.
    expect(controlHeads[0]).toContain('⏎')
    for (const l of requestHeads) expect(l).toContain('.env")')

    // The rows below the feed (Home's next steps) are still whole.
    expect(frame).toContain('Next steps')
  })
})

describe('summariseControlCommand', () => {
  const command = (name: string, args: string[]): ControlCommand => ({
    id: 6,
    command: name,
    args: JSON.stringify(args),
    sourceAgent: 'hermes',
    sourceUser: null,
    status: 'applied',
    error: null,
    createdAt: 0,
    appliedAt: null,
  })

  it('flattens a message to one line and cuts it by columns, not code units', () => {
    const out = summariseControlCommand(command('write', ['manager', `why don't you share\r\nthe plan\t🎉🎉🎉 漢字漢字漢字漢字漢字漢字`]))
    expect(out).toBe("write manager: why don't you share ⏎ the plan 🎉🎉🎉 …")
    expect(displayWidth(out.slice('write manager: '.length))).toBeLessThanOrEqual(40)
  })

  it('makes escapes and carriage returns in any directive visible', () => {
    const out = summariseControlCommand(command('llm-switch', [`openai\r${ESC}[2K`, 'gpt']))
    expect(out).toBe('llm switch openai␍␛[2K gpt')
  })
})

describe('Inbox rows', () => {
  it('keep a title or body with line breaks on one line each', () => {
    const item: InboxItem = {
      id: 'i1',
      createdAt: Date.now(),
      level: 'warning',
      kind: 'agent',
      title: `manager asks:\nwhy don't you share\rthe plan`,
      body: `line one\nline two\tend ${ESC}[2K`,
      requestId: null,
      agentId: 'manager',
      dedupeKey: null,
      readAt: null,
    }
    const { lastFrame, unmount } = render(
      React.createElement(InboxPage, {
        items: [item],
        unread: 1,
        onMarkRead: () => {},
        onMarkAllRead: () => {},
        active: false,
        height: 20,
      }),
    )
    cleanups.push(unmount)
    const frame = strip(lastFrame() ?? '')
    expect(frame).not.toContain('\r')
    expect(frame).not.toContain(ESC)
    const lines = frame.split('\n')
    expect(lines.filter((l) => l.includes("manager asks: ⏎ why don't you share␍the plan"))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('line one ⏎ line two end ␛[2K'))).toHaveLength(1)
  })
})
