import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import React from 'react'
import { render as inkRender, type Instance } from 'ink'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import type { ApprovalRequest } from '../../src/core/approval.js'
import { DelegationTracker, delegationStatusLabel } from '../../src/core/delegation-tracker.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { generateReport } from '../../src/core/security-report.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'
import { ActivityFeed } from '../../src/tui/components/activity-feed.js'
import { ApprovalModal, fitSummary } from '../../src/tui/components/approval-modal.js'
import { DashboardProvider } from '../../src/tui/dashboard-context.js'
import { DelegationsPage } from '../../src/tui/pages/delegations-page.js'
import { LogsPage } from '../../src/tui/pages/logs-page.js'
import { DEFAULT_FILTERS } from '../../src/tui/pages/logs-query.js'

// TUI tour at 80 and 120 columns: long paths and table cells must not wrap
// a row onto a second line.

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

/** ink-testing-library's stdout is always 100 columns; this one is `cols`. */
class Stdout extends EventEmitter {
  frames: string[] = []
  constructor(readonly columns: number) {
    super()
  }
  get rows(): number {
    return 40
  }
  write = (frame: string): void => {
    this.frames.push(frame)
  }
}

const mounted: Instance[] = []
function renderAt(cols: number, tree: React.ReactElement): () => string {
  const stdout = new Stdout(cols)
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding() {},
    setRawMode() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read: () => null,
  })
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new Stdout(cols) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  mounted.push(instance)
  return () => strip(stdout.frames.at(-1) ?? '')
}

const LONG_PATH = `${homedir()}/Projects/clients/acme-corp/infrastructure/tuitour/.env`

let db: ForemanDb
let sqlite: Database.Database
let bus: EventBus<ForemanEventMap>
let registry: RegistryService

beforeEach(() => {
  ;({ db, sqlite } = createInMemoryDb())
  bus = new EventBus<ForemanEventMap>()
  registry = new RegistryService(db, bus)
})
afterEach(() => {
  for (const i of mounted.splice(0)) i.unmount()
  sqlite.close()
})

function withServices(child: React.ReactElement): React.ReactElement {
  return React.createElement(DashboardProvider, { db, sqlite, bus, registry, children: child })
}

function seedRequest(id: string, path: string, createdAt = Date.now() - 60_000): void {
  db.insert(requests)
    .values({
      id,
      sourceAgent: 'claude-code',
      targetTool: 'read_file',
      args: JSON.stringify({ path }),
      riskScore: 80,
      riskReasons: JSON.stringify(['secret_path']),
      riskBucket: 'high',
      decision: 'denied',
      decidedBy: 'policy:7',
      durationMs: 12,
      createdAt,
      decidedAt: createdAt,
    })
    .run()
}

describe.each([80, 120])('at %i columns', (cols) => {
  it('Activity rows stay one line and keep the file name', () => {
    seedRequest('r1', LONG_PATH)
    // Wide layout gives the feed 60% of the terminal; medium gives it all.
    const width = cols >= 120 ? '60%' : undefined
    const frame = renderAt(cols, withServices(React.createElement(ActivityFeed, width ? { width } : {})))()
    const lines = frame.split('\n')
    const call = lines.filter((l) => l.includes('read_file('))
    expect(call).toHaveLength(1)
    expect(call[0]).toContain('~/…/')
    expect(call[0]).toContain('tuitour/.env")')
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(cols)
    // The decision line is its own single line, not a wrapped tail.
    expect(lines.filter((l) => l.includes('denied · policy:7'))).toHaveLength(1)
  })

  it('Logs rows stay one line and keep the file name', () => {
    seedRequest('r1', LONG_PATH)
    const frame = renderAt(
      cols,
      withServices(
        React.createElement(LogsPage, {
          search: '',
          searchMode: false,
          filters: DEFAULT_FILTERS,
          selectedIdx: 0,
          expanded: false,
          exportNotice: null,
          replayNotice: null,
        }),
      ),
    )()
    const lines = frame.split('\n')
    const row = lines.filter((l) => l.includes('read_file('))
    expect(row).toHaveLength(1)
    expect(row[0]).toContain('~/…/')
    expect(row[0]).toContain('/.env")')
    expect(row[0]).toContain('denied · policy:7 · 12ms')
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(cols)
  })

  it('Delegations rows are one line each, with status and age apart', () => {
    const tracker = new DelegationTracker({ db })
    const ok = tracker.recordDelegation({ initiatorAgent: 'hermes', targetAgent: 'codex', prompt: 'review the auth module and report back' })
    tracker.recordOutputReceived({ delegationId: ok, spawnOutcome: 'ok' })
    const broken = tracker.recordDelegation({
      initiatorAgent: 'claude-code',
      targetAgent: 'openclaw-assistant',
      prompt: 'a long task description that goes on and on\nwith a second line',
    })
    tracker.recordOutputReceived({ delegationId: broken, spawnOutcome: 'spawn-error' })
    const frame = renderAt(
      cols,
      withServices(React.createElement(DelegationsPage, { selectedIdx: 0, expanded: false, notice: null })),
    )()
    const lines = frame.split('\n')
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(cols)
    const failedRow = lines.filter((l) => l.includes('spawn-error'))
    expect(failedRow).toHaveLength(1)
    // A hand-off whose spawn failed reads "failed", not "awaiting".
    expect(failedRow[0]).toMatch(/failed\s+\S+\s+claude-code\s+openclaw-as…\s+spawn-error\s+0\s+a long/)
    expect(failedRow[0]).not.toContain('awaiting')
    const okRow = lines.filter((l) => l.includes('hermes'))
    expect(okRow).toHaveLength(1)
    expect(okRow[0]).toMatch(/awaiting\s+\d+(ms|s|m)\s+hermes/)
    expect(frame).toContain('1 awaiting · 0 nudged · 1 failed · 0 escalated')
  })

  it('the approval modal keeps a long path on one line', () => {
    const request: ApprovalRequest = {
      requestId: 'req-1',
      sourceAgent: 'claude-code',
      targetTool: 'read_file',
      args: { path: LONG_PATH },
      riskScore: 80,
      riskReasons: ['secret_path'],
      riskFactors: [],
      riskBucket: 'high',
      llmVerification: null,
      securityReport: null,
    }
    const legacy = renderAt(cols, React.createElement(ApprovalModal, { request, remainingSeconds: 30 }))()
    const legacyLines = legacy.split('\n')
    for (const l of legacyLines) expect(l.length).toBeLessThanOrEqual(cols)
    const call = legacyLines.filter((l) => l.includes('read_file('))
    expect(call).toHaveLength(1)
    expect(call[0]).toContain('tuitour/.env")')

    const report = generateReport({
      sourceAgent: 'claude-code',
      targetTool: 'read_file',
      args: { path: LONG_PATH },
      assessment: { factors: [], totalScore: 80, bucket: 'high', recommendation: 'ask', llmVerification: null },
    })
    const withReport = renderAt(
      cols,
      React.createElement(ApprovalModal, { request: { ...request, securityReport: report }, remainingSeconds: 30 }),
    )()
    const reportLines = withReport.split('\n')
    for (const l of reportLines) expect(l.length).toBeLessThanOrEqual(cols)
    const summary = reportLines.filter((l) => l.includes('wants to read_file'))
    expect(summary).toHaveLength(1)
    expect(summary[0]).toContain('tuitour/.env')
  })
})

describe('fitSummary', () => {
  it('leaves a summary that fits, or one without a path, as it is', () => {
    expect(fitSummary('hermes wants to read_file .env', { path: '.env' }, 80)).toBe('hermes wants to read_file .env')
    expect(fitSummary('hermes wants to shell_exec: ls -la', { cmd: 'ls -la' }, 10)).toBe('hermes wants to shell_exec: ls -la')
  })
  it('swaps the cut-off path for one shortened in the middle', () => {
    const path = `/srv/${'x'.repeat(70)}/tuitour/.env`
    const summary = `hermes wants to read_file ${path.slice(0, 59)}…`
    const out = fitSummary(summary, { path }, 50)
    expect(out.startsWith('hermes wants to read_file /…/')).toBe(true)
    expect(out.endsWith('tuitour/.env')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(50)
  })
})

describe('delegationStatusLabel', () => {
  it('shows a hand-off whose agent could not run as failed', () => {
    for (const outcome of ['failed', 'timeout', 'spawn-error', 'unsupported']) {
      expect(delegationStatusLabel({ status: 'awaiting', spawnOutcome: outcome })).toBe('failed')
      expect(delegationStatusLabel({ status: 'nudged', spawnOutcome: outcome })).toBe('failed')
    }
  })
  it('keeps every other status as stored', () => {
    expect(delegationStatusLabel({ status: 'awaiting', spawnOutcome: 'ok' })).toBe('awaiting')
    expect(delegationStatusLabel({ status: 'open', spawnOutcome: null })).toBe('open')
    expect(delegationStatusLabel({ status: 'escalated', spawnOutcome: 'spawn-error' })).toBe('escalated')
    expect(delegationStatusLabel({ status: 'closed', spawnOutcome: 'failed' })).toBe('closed')
  })
})
