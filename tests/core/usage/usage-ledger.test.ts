import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { InboxService } from '../../../src/core/inbox.js'
import { BudgetWatcher } from '../../../src/core/usage/budget-watcher.js'
import { UsageLedger } from '../../../src/core/usage/ledger.js'
import { OtlpReceiver, USAGE_KEY_HEADER } from '../../../src/core/usage/otlp-receiver.js'
import {
  budgetStatus,
  buildOrgReport,
  parsePeriod,
  renderOrgReport,
  spendBy,
} from '../../../src/core/usage/report.js'
import { parseOrgText } from '../../../src/core/org/org.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { agentUsage, controlCommands, inboxItems, requests } from '../../../src/db/schema.js'

const ORG = `version: 1
company: Acme
departments:
  engineering: { name: Engineering, head: cto }
  marketing: { name: Marketing, head: cmo, budget: { monthly_usd: 10, on_exceed: pause } }
roles:
  ceo: { title: CEO, agent: hermes, reports_to: human }
  cto: { title: CTO, agent: claude-code, department: engineering, reports_to: ceo }
  engineer: { title: Engineer, agent: codex, department: engineering, reports_to: cto }
  cmo: { title: CMO, agent: writer-bot, department: marketing, reports_to: ceo }
`

describe('usage ledger, receiver, reports and budgets (#629)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  let orgPath: string
  let ledger: UsageLedger

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    dir = mkdtempSync(join(tmpdir(), 'foreman-usage-'))
    orgPath = join(dir, 'org.yaml')
    writeFileSync(orgPath, ORG)
    ledger = new UsageLedger(db, { orgConfigPath: orgPath })
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('attributes usage to role and department, and estimates cost only when none was reported', () => {
    const reported = ledger.record({ agentId: 'Writer-Bot', source: 'telemetry', model: 'claude-sonnet-4', input: 10, costUsd: 0.5 })!
    expect([reported.role, reported.department, reported.costUsd, reported.costEstimated]).toEqual(['cmo', 'marketing', 0.5, 0])
    const est = ledger.record({ agentId: 'codex', source: 'task-output', model: 'gpt-5', total: 1_000_000 })!
    expect(est.department).toBe('engineering')
    expect(est.costEstimated).toBe(1)
    expect(est.costUsd).toBeCloseTo(3.4375)
    expect(ledger.record({ agentId: 'codex', source: 'telemetry' })).toBeNull()
    const outsider = ledger.record({ agentId: 'someone', source: 'telemetry', input: 5 })!
    expect([outsider.role, outsider.department]).toEqual([null, null])
  })

  it('receives OTLP logs over HTTP with the key, and refuses everything else', async () => {
    const receiver = new OtlpReceiver({ ledger, key: 'k'.repeat(48), port: 0 })
    const port = await receiver.start()
    const post = (body: string, headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST', body, headers })
    const payload = JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'foreman.agent', value: { stringValue: 'claude-code' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'claude_code.api_request' },
                  attributes: [
                    { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                    { key: 'input_tokens', value: { intValue: '2000' } },
                    { key: 'output_tokens', value: { intValue: '400' } },
                    { key: 'cost_usd', value: { doubleValue: 0.02 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    try {
      expect((await post(payload, { 'content-type': 'application/json' })).status).toBe(401)
      expect((await post(payload, { 'content-type': 'application/json', [USAGE_KEY_HEADER]: 'wrong' })).status).toBe(401)
      expect((await post('x', { 'content-type': 'application/x-protobuf', [USAGE_KEY_HEADER]: 'k'.repeat(48) })).status).toBe(415)
      expect((await post('{', { 'content-type': 'application/json', [USAGE_KEY_HEADER]: 'k'.repeat(48) })).status).toBe(400)
      const big = 'x'.repeat(1_100_000)
      expect((await post(big, { 'content-type': 'application/json', [USAGE_KEY_HEADER]: 'k'.repeat(48) }).catch(() => ({ status: 413 }))).status).toBe(413)
      const ok = await post(payload, { 'content-type': 'application/json', [USAGE_KEY_HEADER]: 'k'.repeat(48) })
      expect(ok.status).toBe(200)
      const rows = db.select().from(agentUsage).all()
      expect(rows.map((r) => [r.agentId, r.department, r.inputTokens, r.outputTokens, r.costUsd])).toEqual([
        ['claude-code', 'engineering', 2000, 400, 0.02],
      ])
    } finally {
      await receiver.stop()
    }
  })

  it("reports a department's work and spend, preferring telemetry over printed usage", () => {
    const now = Date.now()
    ledger.record({ agentId: 'codex', source: 'telemetry', model: 'gpt-5', input: 100, output: 10, costUsd: 1, taskRef: '7', ts: now - 1000 })
    // The same task also printed `tokens used` — must not be counted twice.
    ledger.record({ agentId: 'codex', source: 'task-output', model: 'gpt-5', total: 110, taskRef: '7', ts: now - 900 })
    // A task with only printed usage counts.
    ledger.record({ agentId: 'codex', source: 'task-output', model: 'gpt-5', total: 1_000_000, taskRef: '8', ts: now - 800 })
    ledger.record({ agentId: 'claude-code', source: 'telemetry', costUsd: 2, input: 5, ts: now - 700 })
    ledger.record({ agentId: 'writer-bot', source: 'telemetry', costUsd: 4, input: 5, ts: now - 600 })
    // Yesterday: outside "today".
    ledger.record({ agentId: 'claude-code', source: 'telemetry', costUsd: 100, input: 5, ts: now - 3 * 86_400_000 })
    db.insert(controlCommands).values([
      { command: 'write', args: JSON.stringify(['codex', 'add tests']), sourceAgent: 'claude-code', status: 'applied', createdAt: now - 500 },
      { command: 'write', args: JSON.stringify(['Codex', 'fix ci']), sourceAgent: 'claude-code', status: 'failed', createdAt: now - 400 },
      { command: 'write', args: JSON.stringify(['writer-bot', 'post']), sourceAgent: 'hermes', status: 'applied', createdAt: now - 300 },
    ]).run()
    const req = { args: '{}', riskScore: 1, createdAt: now - 200 }
    db.insert(requests).values([
      { ...req, id: 'r1', sourceAgent: 'codex', decision: 'allowed' as const },
      { ...req, id: 'r2', sourceAgent: 'claude-code', decision: 'denied' as const },
      { ...req, id: 'r3', sourceAgent: 'writer-bot', decision: 'allowed' as const },
    ]).run()
    db.insert(inboxItems).values({
      id: '01J0000000000000000000000A', createdAt: now - 100, level: 'info', kind: 'delegation',
      title: 'codex finished: add tests', body: 'Added 6 tests.', agentId: 'codex', requestId: null, dedupeKey: null, readAt: null,
    }).run()

    const org = parseOrgText(ORG)
    const today = parsePeriod('today', now)!
    const eng = buildOrgReport(db, org, { kind: 'department', id: 'engineering' }, today, now)
    expect(eng.target.name).toBe('Engineering')
    expect(eng.byAgent.map((a) => a.key).sort()).toEqual(['claude-code', 'codex'])
    const codex = eng.byAgent.find((a) => a.key === 'codex')!
    expect(codex.costUsd).toBeCloseTo(1 + 3.4375)
    expect(codex.estimated).toBe(true)
    expect(eng.tasks).toEqual({ finished: 1, failed: 1, pending: 0 })
    expect(eng.toolCalls).toEqual({ allowed: 1, denied: 1 })
    expect(eng.recent.map((r) => r.title)).toEqual(['codex finished: add tests'])
    expect(eng.costPerFinishedTask).toBeCloseTo(6.4375)

    const company = buildOrgReport(db, org, { kind: 'company' }, today, now)
    expect(company.byDepartment.map((d) => d.key)).toEqual(['engineering', 'marketing'])
    expect(company.tasks.finished).toBe(2)
    const text = renderOrgReport(company)
    expect(text).toContain('Acme · today')
    expect(text).toContain('By department')
    expect(text).toContain('Budget marketing (month): $4.00 of $10.00 (40%)')

    const week = buildOrgReport(db, org, { kind: 'department', id: 'engineering' }, parsePeriod('week', now)!, now)
    expect(week.spend.costUsd).toBeCloseTo(106.4375)
    expect(spendBy(db, 'model', today).map((r) => r.key)).toContain('gpt-5')
  })

  it('files budget alerts at 80% and 100%, once each per period', () => {
    const inbox = new InboxService(db, new EventBus<ForemanEventMap>())
    const pushed: string[] = []
    const watcher = new BudgetWatcher(db, { orgConfigPath: orgPath, inbox, notify: (t) => pushed.push(t) })
    ledger.record({ agentId: 'writer-bot', source: 'telemetry', costUsd: 8.5, input: 1 })
    watcher.check()
    watcher.check()
    expect(inbox.list().map((i) => [i.level, i.title])).toEqual([['warning', 'Marketing has used 85% of its monthly budget']])
    ledger.record({ agentId: 'writer-bot', source: 'telemetry', costUsd: 2, input: 1 })
    watcher.check()
    expect(inbox.list()[0]!.title).toBe('Marketing is over its monthly budget')
    expect(inbox.list()[0]!.body).toContain("agents can't hand it new work")
    expect(pushed).toHaveLength(2)
    const status = budgetStatus(db, 'marketing', parseOrgText(ORG).departments.marketing!.budget!)
    expect(status.exceeded).toBe(true)
  })

  it('parses periods', () => {
    const now = new Date(2026, 8, 27, 15, 0, 0).getTime()
    expect(parsePeriod('today', now)!.since).toBe(new Date(2026, 8, 27).getTime())
    expect(parsePeriod('month', now)!.since).toBe(new Date(2026, 8, 1).getTime())
    expect(parsePeriod('bugün', now)!.label).toBe('today')
    expect(parsePeriod('7d', now)!.since).toBe(now - 7 * 86_400_000)
    expect(parsePeriod('marketing', now)).toBeNull()
  })
})
