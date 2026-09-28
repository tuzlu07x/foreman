import { describe, expect, it } from 'vitest'
import { planChannelEnable } from '../../../src/core/notification/channel-setup.js'
import type { ChannelId } from '../../../src/core/notification/types.js'

// QA #657 M10 — `notify enable <channel>` only flipped `enabled: true`, so
// `notify test telegram` failed with "needs bot_token_ref and chat_id"
// even with the documented secrets stored.
const plan = (
  channel: ChannelId,
  stored: Record<string, string>,
  extra: { chatId?: string; target?: string; existing?: Record<string, unknown> } = {},
) =>
  planChannelEnable({
    channel,
    existing: (extra.existing as never) ?? null,
    hasSecret: (n) => n in stored,
    readSecret: (n) => stored[n] ?? null,
    ...(extra.chatId !== undefined ? { chatId: extra.chatId } : {}),
    ...(extra.target !== undefined ? { target: extra.target } : {}),
  })

describe('planChannelEnable', () => {
  it('telegram: the default token ref and the chat id the wizard stored', () => {
    const p = plan('telegram', { 'telegram-bot-token': 't', 'telegram-chat-id': ' 12345 ' })
    expect(p.toggle).toMatchObject({ enabled: true, bot_token_ref: 'telegram-bot-token', chat_id: '12345' })
    expect(p.missing).toEqual([])
  })

  it('telegram: --chat-id wins, and a missing token names the secret to add', () => {
    const p = plan('telegram', { 'telegram-chat-id': '1' }, { chatId: '-100777' })
    expect(p.toggle.chat_id).toBe('-100777')
    expect(p.missing).toEqual(['store the bot token: foreman secrets add telegram-bot-token'])
  })

  it('telegram: says how to give a chat id when none is known', () => {
    expect(plan('telegram', { 'telegram-bot-token': 't' }).missing[0]).toContain('--chat-id <id>')
  })

  it('keeps refs the user already set', () => {
    const p = plan('telegram', {}, { existing: { enabled: false, bot_token_ref: 'my-bot', chat_id: '9' } })
    expect(p.toggle).toMatchObject({ bot_token_ref: 'my-bot', chat_id: '9' })
    expect(p.missing).toEqual(['store the bot token: foreman secrets add my-bot'])
  })

  it('slack: an incoming webhook by default', () => {
    const p = plan('slack', {})
    expect(p.toggle.webhook_url_ref).toBe('slack-webhook-url')
    expect(p.missing).toEqual(['store the slack webhook URL: foreman secrets add slack-webhook-url'])
  })

  it('slack: a bot with --channel', () => {
    const p = plan('slack', { 'slack-bot-token': 'x' }, { target: '#alerts' })
    expect(p.toggle).toMatchObject({ bot_token_ref: 'slack-bot-token', channel: '#alerts' })
    expect(p.toggle.webhook_url_ref).toBeUndefined()
    expect(p.missing).toEqual([])
  })

  it('discord: a stored bot token (the wizard) means bot mode, which needs a channel id', () => {
    const p = plan('discord', { 'discord-bot-token': 'x' })
    expect(p.toggle.bot_token_ref).toBe('discord-bot-token')
    expect(p.missing).toEqual(['give the channel id: foreman notify enable discord --channel <channel-id>'])
  })

  it('webhook: the URL ref, and the signing secret when stored', () => {
    const p = plan('webhook', { 'webhook-url': 'u', 'webhook-secret': 's' })
    expect(p.toggle).toMatchObject({ webhook_url_ref: 'webhook-url', signing_secret_ref: 'webhook-secret' })
    expect(p.missing).toEqual([])
  })
})
