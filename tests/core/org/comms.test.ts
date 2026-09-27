import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { InboxService } from '../../../src/core/inbox.js'
import { BOSS, OrgComms, renderMessages } from '../../../src/core/org/comms.js'
import { CommsMirrorWorker, mirrorsFromNotifyConfig } from '../../../src/core/org/comms-mirror.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { orgMessages } from '../../../src/db/schema.js'

const ORG = `version: 1
company: Acme
departments:
  engineering: { name: Engineering, head: cto, channels: { slack: "#eng", discord: "111111111111111111" } }
  marketing: { name: Marketing, head: cmo, channels: { slack: "#marketing" } }
channels:
  all: { slack: "#company" }
  boss: { discord: "222222222222222222" }
roles:
  ceo: { title: CEO, agent: hermes, reports_to: human }
  cto: { title: CTO, agent: claude-code, department: engineering, reports_to: ceo }
  engineer: { title: Engineer, agent: codex, department: engineering, reports_to: cto }
  cmo: { title: CMO, agent: writer-bot, department: marketing, reports_to: ceo }
  writer: { title: Writer, agent: gemini, department: marketing, reports_to: cmo }
`

describe('department channels (#630)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  let comms: OrgComms
  let events: ForemanEventMap['org:message'][]

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    dir = mkdtempSync(join(tmpdir(), 'foreman-comms-'))
    writeFileSync(join(dir, 'org.yaml'), ORG)
    const bus = new EventBus<ForemanEventMap>()
    events = []
    bus.on('org:message', (e) => events.push(e))
    comms = new OrgComms(db, { orgConfigPath: join(dir, 'org.yaml'), bus })
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('follows the org chart for who may post where', () => {
    const post = (from: string, to: string) => comms.post({ from, to, text: 'hi' })
    // Own department, manager, report, all-hands, the boss.
    expect(post('codex', 'engineering')).toMatchObject({ ok: true, label: '#engineering' })
    expect(post('codex', 'cto')).toMatchObject({ ok: true, label: 'cto ↔ engineer' })
    expect(post('claude-code', 'engineer')).toMatchObject({ ok: true })
    expect(post('codex', 'all')).toMatchObject({ ok: true, label: '#all-hands' })
    expect(post('codex', 'boss')).toMatchObject({ ok: true, label: '→ you' })
    // Cross-department only through the heads (via_heads is the default).
    expect(post('codex', 'marketing')).toMatchObject({ ok: false, reason: expect.stringContaining('department head') })
    expect(post('codex', 'writer')).toMatchObject({ ok: false })
    expect(post('claude-code', 'marketing')).toMatchObject({ ok: true })
    expect(post('claude-code', 'cmo')).toMatchObject({ ok: true })
    // Leadership is for heads and the roles that report to you.
    expect(post('codex', 'leadership')).toMatchObject({ ok: false })
    expect(post('hermes', 'leadership')).toMatchObject({ ok: true })
    // Outsiders can only write to you.
    expect(post('stranger', 'engineering')).toMatchObject({ ok: false })
    expect(post('stranger', 'boss')).toMatchObject({ ok: true })
    // You can post anywhere.
    expect(comms.post({ from: BOSS, asOwner: true, to: 'writer', text: 'x' })).toMatchObject({ ok: true, label: 'boss ↔ writer'.replace('boss', 'you') })
    expect(post('codex', 'nobody')).toMatchObject({ ok: false, reason: expect.stringContaining("no department, role or agent called 'nobody'") })
    expect(post('codex', 'engineer')).toMatchObject({ ok: false, reason: "that's you" })
    expect(events.length).toBe(comms.read({ viewer: BOSS, asOwner: true, limit: 200 }).length)
  })

  it('shows each agent only what it may read; you see everything', () => {
    comms.post({ from: 'codex', to: 'engineering', text: 'CI is green' })
    comms.post({ from: 'gemini', to: 'marketing', text: 'draft ready' })
    comms.post({ from: 'claude-code', to: 'leadership', text: 'ship Friday?' })
    comms.post({ from: 'writer-bot', to: 'writer', text: 'tighten the intro' })
    comms.post({ from: 'hermes', to: 'all', text: 'launch week' })
    const texts = (viewer: string) => comms.read({ viewer }).map((m) => m.text)
    expect(texts('codex')).toEqual(['CI is green', 'launch week'])
    expect(texts('claude-code')).toEqual(['CI is green', 'ship Friday?', 'launch week'])
    expect(texts('gemini')).toEqual(['draft ready', 'tighten the intro', 'launch week'])
    expect(comms.read({ viewer: BOSS, asOwner: true })).toHaveLength(5)
    expect(comms.read({ viewer: 'codex', channel: 'marketing' })).toEqual([])
    expect(comms.read({ viewer: BOSS, asOwner: true, channel: 'marketing' }).map((m) => m.text)).toEqual(['draft ready'])
  })

  it('reports go to the manager, or to you from the top', () => {
    expect(comms.report('codex', 'done: rate limiting')).toMatchObject({ ok: true, label: 'cto ↔ engineer' })
    expect(comms.report('hermes', 'weekly summary')).toMatchObject({ ok: true, label: '→ you' })
    const [first] = comms.read({ viewer: BOSS, asOwner: true })
    expect(first!.kind).toBe('report')
  })

  it('stores messages clean: no secrets, no terminal escapes, clipped', () => {
    const r = comms.post({ from: 'codex', to: 'engineering', text: `key ghp_${'a'.repeat(36)} \u001b[2Jdone ${'x'.repeat(5000)}` })
    expect(r.ok).toBe(true)
    const [m] = comms.read({ viewer: BOSS, asOwner: true })
    expect(m!.text).not.toContain('ghp_')
    expect(m!.text).not.toContain('\u001b')
    expect(m!.text.length).toBeLessThanOrEqual(4000)
    expect(renderMessages([m!])).toContain('#engineering · engineer (codex)')
  })

  it('mirrors each message once to the mapped channels, without pings, and files messages to you in the inbox', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: '1' }) }
    }
    const inbox = new InboxService(db, new EventBus<ForemanEventMap>())
    const worker = new CommsMirrorWorker(db, {
      orgConfigPath: join(dir, 'org.yaml'),
      mirrors: mirrorsFromNotifyConfig({ slack: 'xoxb-1', discord: 'bot' }, fetchImpl),
      inbox,
    })
    comms.post({ from: 'codex', to: 'engineering', text: '@everyone <!channel> deploy done' })
    comms.post({ from: 'hermes', to: 'boss', text: 'need a decision on pricing', kind: 'question' })
    comms.post({ from: 'writer-bot', to: 'writer', text: 'thread, not mirrored' })
    await worker.tick()
    await worker.tick()
    const slack = calls.filter((c) => new URL(c.url).hostname === 'slack.com')
    const discord = calls.filter((c) => new URL(c.url).hostname === 'discord.com')
    expect(slack.map((c) => c.body.channel)).toEqual(['#eng'])
    expect(String(slack[0]!.body.text)).toContain('&lt;!channel&gt;')
    expect(discord.map((c) => c.url)).toEqual([
      'https://discord.com/api/v10/channels/111111111111111111/messages',
      'https://discord.com/api/v10/channels/222222222222222222/messages',
    ])
    expect(discord[0]!.body.allowed_mentions).toEqual({ parse: [] })
    expect(inbox.list().map((i) => [i.kind, i.title, i.level])).toEqual([['message', 'ceo (hermes) → you · question', 'warning']])
    expect(db.select().from(orgMessages).all().every((m) => m.mirroredAt !== null)).toBe(true)
  })

  it('warns once when a mapped platform has no bot token', async () => {
    const inbox = new InboxService(db, new EventBus<ForemanEventMap>())
    const worker = new CommsMirrorWorker(db, { orgConfigPath: join(dir, 'org.yaml'), mirrors: new Map(), inbox })
    comms.post({ from: 'codex', to: 'engineering', text: 'a' })
    comms.post({ from: 'codex', to: 'engineering', text: 'b' })
    await worker.tick()
    const warnings = inbox.list().filter((i) => i.kind === 'system').map((i) => i.title)
    expect(warnings.sort()).toEqual([
      'org.yaml maps #engineering to discord, but discord has no bot token in notify.yaml',
      'org.yaml maps #engineering to slack, but slack has no bot token in notify.yaml',
    ].sort())
  })
})
