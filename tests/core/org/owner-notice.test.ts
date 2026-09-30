import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import { InboxService } from '../../../src/core/inbox.js'
import { TelegramChannel } from '../../../src/core/notification/channels/telegram.js'
import { NotificationService } from '../../../src/core/notification/notification-service.js'
import { defaultNotifyConfig, type NotifyConfig } from '../../../src/core/notification/notify-config.js'
import type {
  ChannelId,
  ChannelMessageRef,
  Notification,
  NotificationChannel,
} from '../../../src/core/notification/types.js'
import { BOSS, OrgComms } from '../../../src/core/org/comms.js'
import { CommsMirrorWorker, mirrorsFromNotifyConfig } from '../../../src/core/org/comms-mirror.js'
import { loadOrg } from '../../../src/core/org/org.js'
import {
  clipForOwner,
  FULL_TEXT_HINT,
  isToOwner,
  OWNER_NOTICE_MAX,
  ownerChatTargets,
  ownerNotice,
  ownerNotifier,
  sameChatChannel,
} from '../../../src/core/org/owner-notice.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { notificationMessages, notifications, orgMessages, type OrgMessage } from '../../../src/db/schema.js'

// Finding 33: reports to you never reached Telegram.

const ORG = `version: 1
company: Acme
departments:
  engineering: { name: Engineering, head: cto }
roles:
  manager: { title: Engineering Manager, agent: hermes, reports_to: human }
  cto: { title: CTO, agent: claude-code, department: engineering, reports_to: manager }
  engineer: { title: Engineer, agent: codex, department: engineering, reports_to: cto }
`

/** The owner's notification channels: Slack and Discord through a bot. */
const SLACK_ALERTS = '#foreman'
const DISCORD_ALERTS = '333333333333333333'

class FakeChannel implements NotificationChannel {
  readonly sent: Notification[] = []
  constructor(readonly id: ChannelId) {}
  async isReady(): Promise<boolean> {
    return true
  }
  async send(n: Notification): Promise<ChannelMessageRef> {
    this.sent.push(n)
    return { channelMessageId: `${this.id}-${this.sent.length}` }
  }
  async updateMessage(): Promise<void> {}
  async listen(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function notifyConfig(): NotifyConfig {
  const config = defaultNotifyConfig()
  config.channels.telegram = { enabled: true, bot_token_ref: 'telegram-bot-token', chat_id: '42' }
  config.channels.slack = { enabled: true, bot_token_ref: 'slack-bot-token', channel: SLACK_ALERTS }
  config.channels.discord = { enabled: true, bot_token_ref: 'discord-bot-token', channel: DISCORD_ALERTS }
  return config
}

function row(over: Partial<OrgMessage>): OrgMessage {
  return {
    id: '01',
    ts: 0,
    channel: BOSS,
    fromAgent: 'hermes',
    fromRole: 'manager',
    kind: 'report',
    text: 'Q3 shipped',
    replyTo: null,
    mirroredAt: null,
    ...over,
  }
}

describe('messages to you (finding 33): routing and formatting', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-owner-notice-'))
    writeFileSync(join(dir, 'org.yaml'), ORG)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('only messages addressed to you are for your phone', () => {
    expect(isToOwner(row({}))).toBe(true)
    expect(isToOwner(row({ kind: 'question' }))).toBe(true)
    // A role's direct thread with you.
    expect(isToOwner(row({ channel: 'dm:boss|manager', kind: 'message' }))).toBe(true)
    // Colleagues talking: a thread, a department, all-hands, leadership.
    expect(isToOwner(row({ channel: 'dm:cto|engineer', fromAgent: 'codex', fromRole: 'engineer' }))).toBe(false)
    expect(isToOwner(row({ channel: 'dept:engineering' }))).toBe(false)
    expect(isToOwner(row({ channel: 'all', kind: 'announcement' }))).toBe(false)
    expect(isToOwner(row({ channel: 'leadership' }))).toBe(false)
    // A role whose id merely contains "boss" is not you.
    expect(isToOwner(row({ channel: 'dm:bossy|cto' }))).toBe(false)
    // Your own words, and rows Foreman writes about approvals.
    expect(isToOwner(row({ channel: 'dm:boss|manager', fromAgent: BOSS, fromRole: null }))).toBe(false)
    expect(isToOwner(row({ kind: 'review', fromAgent: 'foreman', fromRole: null }))).toBe(false)
    expect(isToOwner(row({ kind: 'recommendation' }))).toBe(false)
  })

  it('says who wrote it: the role title and id, or the agent id', () => {
    const org = loadOrg(join(dir, 'org.yaml'))
    expect(ownerNotice(row({}), org)).toEqual({ level: 'info', title: 'Report from Engineering Manager (manager)', body: 'Q3 shipped' })
    expect(ownerNotice(row({ kind: 'question', text: 'price?' }), org)).toMatchObject({
      level: 'warning',
      title: 'Question from Engineering Manager (manager)',
    })
    // Not in the org (a verified agent with no role), or a role since removed.
    expect(ownerNotice(row({ fromAgent: 'helper', fromRole: null }), org).title).toBe('Report from helper')
    expect(ownerNotice(row({ fromRole: 'gone' }), org).title).toBe('Report from gone')
    expect(ownerNotice(row({}), null).title).toBe('Report from manager')
  })

  it('labels an unverified connection and never shows it as the role it claims', () => {
    const org = loadOrg(join(dir, 'org.yaml'))
    // Even with a role on the row, which OrgComms never writes for one.
    const notice = ownerNotice(row({ fromAgent: 'untrusted:hermes', fromRole: 'manager', text: 'all done' }), org)
    expect(notice.title).toBe('Report from ⚠ unverified: hermes')
    expect(notice.title).not.toContain('Engineering Manager')
    expect(notice.title).not.toContain('(manager)')
    expect(notice.body).toBe("Sent without a valid agent token: Foreman can't confirm it is hermes.\n\nall done")
    // A claimed id can't smuggle markup or control characters.
    expect(ownerNotice(row({ fromAgent: 'untrusted:x\u001b[31m<b>', fromRole: null }), org).title).toBe('Report from ⚠ unverified: x?b?')
  })

  it('clips long text and says where the rest is', () => {
    expect(clipForOwner('short')).toBe('short')
    const exact = 'a'.repeat(OWNER_NOTICE_MAX)
    expect(clipForOwner(exact)).toBe(exact)
    const long = clipForOwner('b'.repeat(4_000))
    expect(long).toBe(`${'b'.repeat(OWNER_NOTICE_MAX)}\n${FULL_TEXT_HINT}`)
    // Fits every channel with its header: Slack clips at 2 900.
    expect(long.length).toBeLessThan(2_900)
    // An emoji on the cut isn't split in half.
    const emoji = clipForOwner(`${'c'.repeat(OWNER_NOTICE_MAX - 1)}😀tail`)
    expect(emoji).toBe(`${'c'.repeat(OWNER_NOTICE_MAX - 1)}\n${FULL_TEXT_HINT}`)
  })

  it('knows when a mirror posts where your notifications go', () => {
    expect(sameChatChannel('#foreman', 'foreman')).toBe(true)
    expect(sameChatChannel('#Foreman', ' #foreman ')).toBe(true)
    expect(sameChatChannel('#reports', '#foreman')).toBe(false)
    expect(sameChatChannel('#foreman', undefined)).toBe(false)
    expect(sameChatChannel('', '')).toBe(false)
    expect(ownerChatTargets(notifyConfig())).toEqual({ slack: SLACK_ALERTS, discord: DISCORD_ALERTS })
    // A webhook's channel is unknown: never counted as the same place.
    const hooks = notifyConfig()
    hooks.channels.slack = { enabled: true, webhook_url_ref: 'slack-webhook', bot_token_ref: 'slack-bot-token', channel: SLACK_ALERTS }
    hooks.channels.discord = { enabled: true, webhook_url_ref: 'discord-webhook' }
    expect(ownerChatTargets(hooks)).toEqual({})
  })

  it('pushes to the enabled chat channels only, and holds during silence or for a muted agent', async () => {
    const calls: Array<{ channels: readonly string[]; level: string; title: string }> = []
    const service = {
      sendTo: async (channels: readonly string[], level: string, payload: Omit<Notification, 'id'>) => {
        calls.push({ channels, level, title: payload.title })
        expect(payload).toMatchObject({ requestId: null, actions: [], agentBlocking: false })
        return { notificationId: 'n', outcomes: new Map() }
      },
    }
    const config = notifyConfig()
    config.channels.discord = { enabled: false }
    config.channels.system = { enabled: true }
    config.channels.email = { enabled: true }
    let state = { silencedUntil: null as number | null, mutedAgents: [] as string[] }
    const owner = ownerNotifier({ service, config, getState: () => state })
    const notice = { level: 'info' as const, title: 'Report from x', body: 'y' }
    await owner.send(notice, { fromAgent: 'hermes', skip: new Set() })
    await owner.send(notice, { fromAgent: 'hermes', skip: new Set(['slack']) })
    expect(calls.map((c) => c.channels)).toEqual([['telegram', 'slack'], ['telegram']])

    state = { silencedUntil: Date.now() + 60_000, mutedAgents: [] }
    await owner.send(notice, { fromAgent: 'hermes', skip: new Set() })
    state = { silencedUntil: null, mutedAgents: ['hermes'] }
    await owner.send(notice, { fromAgent: 'hermes', skip: new Set() })
    expect(calls).toHaveLength(2)
    // Muting hermes doesn't mute a connection that only claims to be it.
    await owner.send(notice, { fromAgent: 'untrusted:hermes', skip: new Set() })
    expect(calls).toHaveLength(3)
    // Nothing enabled: no call at all.
    await ownerNotifier({ service, config: defaultNotifyConfig() }).send(notice, { fromAgent: 'hermes', skip: new Set() })
    expect(calls).toHaveLength(3)
  })
})

describe('messages to you (finding 33): from the org to your chat channels', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  let orgPath: string
  let comms: OrgComms
  let inbox: InboxService
  let fakes: Record<'telegram' | 'slack' | 'discord', FakeChannel>
  let service: NotificationService

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    dir = mkdtempSync(join(tmpdir(), 'foreman-owner-push-'))
    orgPath = join(dir, 'org.yaml')
    writeFileSync(orgPath, ORG)
    comms = new OrgComms(db, { orgConfigPath: orgPath })
    inbox = new InboxService(db, new EventBus<ForemanEventMap>())
    fakes = { telegram: new FakeChannel('telegram'), slack: new FakeChannel('slack'), discord: new FakeChannel('discord') }
    service = new NotificationService({ db, config: notifyConfig(), channels: new Map(Object.entries(fakes)) as Map<ChannelId, NotificationChannel> })
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const worker = (opts: { mirrors?: ReturnType<typeof mirrorsFromNotifyConfig>; now?: () => number } = {}) =>
    new CommsMirrorWorker(db, {
      orgConfigPath: orgPath,
      mirrors: opts.mirrors ?? new Map(),
      inbox,
      owner: ownerNotifier({ service, config: notifyConfig() }),
      ...(opts.now ? { now: opts.now } : {}),
    })
  const titles = (c: FakeChannel) => c.sent.map((n) => n.title)

  it("a manager's report reaches Telegram, Slack and Discord once each; colleague talk reaches none", async () => {
    expect(comms.report('hermes', 'Q3 shipped. Two hires start Monday.')).toMatchObject({ ok: true, message: { channel: BOSS } })
    // Colleagues: a thread, a department, all-hands, and a report that
    // goes to the engineer's manager, not to you.
    expect(comms.post({ from: 'codex', to: 'cto', text: 'please review my PR' }).ok).toBe(true)
    expect(comms.post({ from: 'claude-code', to: 'engineering', text: 'standup at 10' }).ok).toBe(true)
    expect(comms.post({ from: 'codex', to: 'all', text: 'cake in the kitchen' }).ok).toBe(true)
    expect(comms.report('codex', 'tests are green')).toMatchObject({ ok: true, label: 'cto ↔ engineer' })

    const w = worker()
    await w.tick()
    await w.tick()
    await w.tick()
    for (const fake of Object.values(fakes)) {
      expect(fake.sent).toHaveLength(1)
      expect(fake.sent[0]).toMatchObject({
        level: 'info',
        requestId: null,
        title: 'Report from Engineering Manager (manager)',
        body: 'Q3 shipped. Two hires start Monday.',
        actions: [],
        agentBlocking: false,
      })
    }
    // Still in the TUI inbox, and in the notifications audit table.
    expect(inbox.list().map((i) => i.title)).toEqual(['manager (hermes) → you · report'])
    expect(db.select().from(notifications).all()).toMatchObject([{ status: 'sent', level: 'info', requestId: null }])
    expect(db.select().from(notificationMessages).all().map((r) => r.channel).sort()).toEqual(['discord', 'slack', 'telegram'])
    expect(db.select().from(orgMessages).all().every((m) => m.mirroredAt !== null)).toBe(true)
  })

  it("a role's direct message and question to you are pushed; your own replies are not", async () => {
    expect(comms.post({ from: 'hermes', to: 'dm:boss|manager', text: 'can we talk pricing?', kind: 'question' }).ok).toBe(true)
    expect(comms.post({ from: BOSS, asOwner: true, to: 'manager', text: 'sure, 3pm' }).ok).toBe(true)
    await worker().tick()
    expect(titles(fakes.telegram)).toEqual(['Question from Engineering Manager (manager)'])
    expect(fakes.telegram.sent[0]!.level).toBe('warning')
  })

  it('an unverified connection reaches you, labelled, never as the role it claims', async () => {
    expect(comms.report('untrusted:hermes', 'wire the money today')).toMatchObject({ ok: true, message: { channel: BOSS, fromRole: null } })
    // It can't reach a colleague at all.
    expect(comms.post({ from: 'untrusted:hermes', to: 'cto', text: 'hi' }).ok).toBe(false)
    await worker().tick()
    for (const fake of Object.values(fakes)) {
      expect(titles(fake)).toEqual(['Report from ⚠ unverified: hermes'])
      expect(fake.sent[0]!.body).toContain("Foreman can't confirm it is hermes")
      expect(fake.sent[0]!.title).not.toContain('Engineering Manager')
    }
  })

  it('a long report is clipped with a pointer to the full text', async () => {
    comms.report('hermes', 'x'.repeat(3_900))
    await worker().tick()
    const body = fakes.telegram.sent[0]!.body
    expect(body.endsWith(FULL_TEXT_HINT)).toBe(true)
    expect(body.length).toBe(OWNER_NOTICE_MAX + 1 + FULL_TEXT_HINT.length)
  })

  it("doesn't push old news after a long restart; the inbox still gets it", async () => {
    comms.report('hermes', 'from last week')
    await worker({ now: () => Date.now() + 2 * 24 * 3_600_000 }).tick()
    for (const fake of Object.values(fakes)) expect(fake.sent).toEqual([])
    expect(inbox.list()).toHaveLength(1)
  })

  it('skips a platform the boss mirror already posted to, in the same channel only', async () => {
    writeFileSync(orgPath, `${ORG}channels:\n  boss: { discord: "${DISCORD_ALERTS}", slack: "#reports" }\n`)
    const calls: string[] = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push(`${new URL(url).hostname} ${String((JSON.parse(String(init.body)) as { channel?: string }).channel ?? url.split('/').at(-2))}`)
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: '1' }) }
    }
    comms.report('hermes', 'Q3 shipped')
    await worker({ mirrors: mirrorsFromNotifyConfig({ slack: 'xoxb-1', discord: 'bot' }, fetchImpl) }).tick()
    expect(calls.sort()).toEqual([`discord.com ${DISCORD_ALERTS}`, 'slack.com #reports'])
    // Discord: the mirror already posted in your alerts channel. Slack: the
    // mirror went to #reports, a different place, so your alerts get it.
    expect(fakes.discord.sent).toEqual([])
    expect(titles(fakes.slack)).toEqual(['Report from Engineering Manager (manager)'])
    expect(titles(fakes.telegram)).toEqual(['Report from Engineering Manager (manager)'])
  })

  it('still pushes when that mirror post failed, and a rate-limited mirror never pushes twice', async () => {
    writeFileSync(orgPath, `${ORG}channels:\n  boss: { discord: "${DISCORD_ALERTS}" }\n`)
    let status = 500
    const fetchImpl = async () => ({ ok: status === 200, status, text: async () => JSON.stringify({ id: '1' }) })
    const mirrors = mirrorsFromNotifyConfig({ discord: 'bot' }, fetchImpl)
    comms.report('hermes', 'first')
    await worker({ mirrors }).tick()
    // The mirror failed, so your Discord channel hasn't seen it yet.
    expect(titles(fakes.discord)).toHaveLength(1)

    status = 429
    let now = Date.now()
    const w = worker({ mirrors, now: () => now })
    comms.report('hermes', 'second')
    await w.tick()
    // Rate limited: left for a later pass, nothing pushed yet.
    expect(fakes.telegram.sent).toHaveLength(1)
    status = 200
    now += 11_000
    await w.tick()
    await w.tick()
    expect(fakes.telegram.sent.map((n) => n.body)).toEqual(['first', 'second'])
    // Delivered to your Discord channel by the mirror: no second post.
    expect(fakes.discord.sent.map((n) => n.body)).toEqual(['first'])
  })

  it('a hung channel does not hold up the mirror', async () => {
    const sent: string[] = []
    const w = new CommsMirrorWorker(db, {
      orgConfigPath: orgPath,
      mirrors: new Map(),
      inbox,
      owner: {
        chatTargets: {},
        send: (notice) => {
          sent.push(notice.body)
          return new Promise<void>(() => {})
        },
      },
    })
    comms.report('hermes', 'first')
    comms.report('hermes', 'second')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const tick = w.tick()
      await vi.advanceTimersByTimeAsync(30_000)
      await tick
    } finally {
      vi.useRealTimers()
    }
    expect(sent).toEqual(['first', 'second'])
    expect(db.select().from(orgMessages).all().every((m) => m.mirroredAt !== null)).toBe(true)
  })

  it('renders on Telegram as plain, escaped text with no buttons', async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = []
    const telegram = new TelegramChannel({
      botToken: 'bot-token',
      chatId: '42',
      fetchImpl: async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7, chat: { id: 42 } } }), text: async () => '' }
      },
    })
    service = new NotificationService({ db, config: notifyConfig(), channels: new Map([['telegram', telegram]]) })
    comms.report('hermes', 'Revenue +12% (Q3). *Great* [link](x)')
    await worker().tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.telegram.org/botbot-token/sendMessage')
    expect(sent[0]!.body).toMatchObject({ chat_id: '42', parse_mode: 'MarkdownV2' })
    expect(sent[0]!.body.reply_markup).toBeUndefined()
    const text = String(sent[0]!.body.text)
    expect(text).toContain('Report from Engineering Manager \\(manager\\)')
    expect(text).toContain('Revenue \\+12% \\(Q3\\)\\. \\*Great\\* \\[link\\]\\(x\\)')
  })
})
