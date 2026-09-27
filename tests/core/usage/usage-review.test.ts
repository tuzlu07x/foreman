import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { InboxService } from '../../../src/core/inbox.js'
import { parseOrgText } from '../../../src/core/org/org.js'
import { BudgetWatcher } from '../../../src/core/usage/budget-watcher.js'
import { UsageLedger } from '../../../src/core/usage/ledger.js'
import { OtlpReceiver, USAGE_KEY_HEADER } from '../../../src/core/usage/otlp-receiver.js'
import { buildOrgReport, parsePeriod } from '../../../src/core/usage/report.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { agentUsage } from '../../../src/db/schema.js'

// Regression tests for the review of spend and budgets (#629).

const ORG = `version: 1
company: Acme
departments:
  engineering: { name: Engineering, head: cto }
  marketing: { name: Marketing, head: cmo, budget: { daily_usd: 1 } }
roles:
  cto: { title: CTO, agent: claude-code, department: engineering, reports_to: human }
  cmo: { title: CMO, agent: writer-bot, department: marketing, reports_to: human }
`

const payload = (agent: string, cost: number) =>
  JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'foreman.agent', value: { stringValue: agent } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  { key: 'input_tokens', value: { intValue: '10' } },
                  { key: 'cost_usd', value: { doubleValue: cost } },
                ],
              },
            ],
          },
        ],
      },
    ],
  })

describe('spend and budgets — review fixes', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  let orgPath: string
  let ledger: UsageLedger

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    dir = mkdtempSync(join(tmpdir(), 'foreman-usage-review-'))
    orgPath = join(dir, 'org.yaml')
    writeFileSync(orgPath, ORG)
    ledger = new UsageLedger(db, { orgConfigPath: orgPath })
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("books a task key's usage to its own agent and task, whatever the payload claims", async () => {
    const receiver = new OtlpReceiver({ ledger, key: 'i'.repeat(48), port: 0 })
    const port = await receiver.start()
    const post = (key: string, body: string) =>
      fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [USAGE_KEY_HEADER]: key },
        body,
      })
    try {
      const taskKey = receiver.issueTaskKey('claude-code', '17')
      // A compromised engineering agent tries to bill marketing.
      expect((await post(taskKey, payload('writer-bot', 999))).status).toBe(200)
      expect((await post('f'.repeat(48), payload('writer-bot', 1))).status).toBe(401)
      const rows = db.select().from(agentUsage).all()
      expect(rows.map((r) => [r.agentId, r.department, r.taskRef, r.costUsd])).toEqual([
        ['claude-code', 'engineering', '17', 100], // capped per record
      ])
      // The install key (agents you set up yourself) is trusted for the agent id.
      expect((await post('i'.repeat(48), payload('writer-bot', 0.5))).status).toBe(200)
      expect(db.select().from(agentUsage).all().at(-1)!.agentId).toBe('writer-bot')
      // A revoked task key stops working after its grace period.
      receiver.revokeTaskKey(taskKey, 10)
      await new Promise((r) => setTimeout(r, 30))
      expect((await post(taskKey, payload('claude-code', 1))).status).toBe(401)
      // Oversize bodies get a proper 413.
      const big = await post('i'.repeat(48), 'x'.repeat(1_100_000)).catch(() => null)
      expect(big?.status).toBe(413)
    } finally {
      await receiver.stop()
    }
  })

  it('re-arms budget alerts when you raise the budget mid-period', () => {
    const inbox = new InboxService(db, new EventBus<ForemanEventMap>())
    const watcher = new BudgetWatcher(db, { orgConfigPath: orgPath, inbox })
    ledger.record({ agentId: 'writer-bot', source: 'telemetry', costUsd: 1.2, input: 1 })
    watcher.check()
    writeFileSync(orgPath, ORG.replace('daily_usd: 1', 'daily_usd: 2'))
    ledger.record({ agentId: 'writer-bot', source: 'telemetry', costUsd: 1, input: 1 })
    watcher.check()
    const titles = inbox.list().map((i) => i.title)
    expect(titles.filter((t) => t.includes('over its daily budget'))).toHaveLength(2)
  })

  it('reports a department from what was booked to it, like its budget', () => {
    ledger.record({ agentId: 'claude-code', source: 'telemetry', costUsd: 2, input: 1 })
    // Later claude-code moves to marketing and codex becomes CTO:
    // engineering's history stays with engineering.
    const moved = ORG.replace('agent: claude-code', 'agent: codex').concat(
      '  advisor: { title: Advisor, agent: claude-code, department: marketing, reports_to: cmo }\n',
    )
    writeFileSync(orgPath, moved)
    const today = parsePeriod('today')!
    const org = parseOrgText(moved)
    expect(buildOrgReport(db, org, { kind: 'department', id: 'engineering' }, today).spend.costUsd).toBe(2)
    expect(buildOrgReport(db, org, { kind: 'department', id: 'marketing' }, today).spend.costUsd).toBe(0)
  })

  it('leaves task output out unless you asked', () => {
    const today = parsePeriod('today')!
    const org = parseOrgText(ORG)
    const r = buildOrgReport(db, org, { kind: 'company' }, today, Date.now(), false)
    expect(r.recent).toEqual([])
  })

  it('yesterday is a calendar day, daylight saving included', () => {
    const now = new Date(2026, 2, 30, 12, 0, 0).getTime()
    const y = parsePeriod('yesterday', now)!
    expect(new Date(y.since).getDate()).toBe(29)
    expect(new Date(y.since).getHours()).toBe(0)
  })
})
