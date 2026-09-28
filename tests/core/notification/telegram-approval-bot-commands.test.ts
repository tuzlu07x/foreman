import { describe, expect, it } from 'vitest'
import { TelegramChannel, type TelegramFetch } from '../../../src/core/notification/channels/telegram.js'

// Integrations plan §6: the approval bot (only Foreman polls it) takes
// `/integrations`, `/integration …` and `/foreman …` from your own private
// chat, and ignores everything else without a reply.

const APPROVAL = 'APPROVAL_TOKEN'
const CHAT = '424242'

function harness(messages: unknown[]) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  const seen: Array<{ text: string; user: string }> = []
  let served = false
  const fetchImpl: TelegramFetch = async (url, init) => {
    const method = /\/(\w+)$/.exec(url)![1]!
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body })
    if (method === 'getUpdates') {
      const result = served ? [] : messages.map((message, i) => ({ update_id: i + 1, message }))
      served = true
      if (result.length === 0) await new Promise((r) => setTimeout(r, 20))
      return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => '' }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), text: async () => '' }
  }
  const channel = new TelegramChannel({
    botToken: 'MAIN',
    chatId: CHAT,
    fetchImpl,
    approvalBotToken: APPROVAL,
    pollTimeoutSeconds: 0,
    pollBackoffMs: 10,
    minPollIntervalMs: 10,
    onCommand: async (text, user) => {
      seen.push({ text, user })
      return `ran: ${text}`
    },
  })
  return { channel, calls, seen }
}

const dm = (text: string, over: { from?: unknown; chat?: unknown } = {}) => ({
  text,
  from: { id: Number(CHAT), is_bot: false },
  chat: { id: Number(CHAT), type: 'private' },
  ...over,
})

const settle = () => new Promise((r) => setTimeout(r, 120))

describe('Telegram approval bot commands', () => {
  it('runs commands from your private chat, strips @bot, replies and lists the commands', async () => {
    const h = harness([dm('/integration@ForemanApprovalBot disable jira'), dm('/integrations')])
    await h.channel.listen(async () => undefined)
    await settle()
    await h.channel.shutdown()
    expect(h.seen).toEqual([
      { text: '/integration disable jira', user: CHAT },
      { text: '/integrations', user: CHAT },
    ])
    const replies = h.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body)
    expect(replies).toEqual([
      { chat_id: CHAT, text: 'ran: /integration disable jira' },
      { chat_id: CHAT, text: 'ran: /integrations' },
    ])
    expect(h.calls.some((c) => c.method === 'setMyCommands')).toBe(true)
  })

  it('ignores someone else, a group chat, a bot sender and unknown commands', async () => {
    const h = harness([
      dm('/integration disable jira', { from: { id: 999, is_bot: false } }),
      dm('/integration disable jira', { chat: { id: Number(CHAT), type: 'group' } }),
      dm('/integration disable jira', { chat: { id: -100, type: 'private' } }),
      dm('/integration disable jira', { from: { id: Number(CHAT), is_bot: true } }),
      dm('/integrationsXYZ'),
      dm('please /integration disable jira'),
    ])
    await h.channel.listen(async () => undefined)
    await settle()
    await h.channel.shutdown()
    expect(h.seen).toEqual([])
    expect(h.calls.filter((c) => c.method === 'sendMessage')).toEqual([])
  })
})
