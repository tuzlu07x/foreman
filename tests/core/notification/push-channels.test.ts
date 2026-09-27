import { describe, expect, it } from 'vitest'
import { buildChannel, buildEnabledChannels } from '../../../src/core/notification/channel-factory.js'
import { DiscordChannel } from '../../../src/core/notification/channels/discord.js'
import { ChannelDeliveryError, type HttpFetch } from '../../../src/core/notification/channels/http-post.js'
import { NtfyChannel } from '../../../src/core/notification/channels/ntfy.js'
import { SlackChannel } from '../../../src/core/notification/channels/slack.js'
import { NotifyConfigSchema } from '../../../src/core/notification/notify-config.js'
import type { Notification } from '../../../src/core/notification/types.js'

function recorder(responses: Array<{ status?: number; body?: string }> = []) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = []
  let i = 0
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null })
    const r = responses[i++] ?? {}
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, text: async () => r.body ?? '' }
  }
  return { calls, fetchImpl }
}

const approval: Notification = {
  id: 'n1',
  level: 'critical',
  requestId: '01JAPPROVAL',
  title: 'hermes wants to read .env',
  body: 'Args: {"path":".env"} <!channel> @everyone',
  actions: [
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' },
  ],
  agentBlocking: true,
}

describe('SlackChannel', () => {
  it('posts escaped Block Kit to an incoming webhook, never an approval token', async () => {
    const r = recorder()
    const ch = new SlackChannel({ target: { kind: 'webhook', url: 'https://hooks.slack.com/services/X' }, fetchImpl: r.fetchImpl })
    await ch.send(approval)
    const payload = JSON.stringify(r.calls[0]!.body)
    expect(r.calls[0]!.url).toBe('https://hooks.slack.com/services/X')
    expect(payload).toContain('&lt;!channel&gt;') // agent text can't ping the channel
    expect(payload).not.toContain('01JAPPROVAL.')
    expect(payload).toContain('Decide in the Foreman TUI')
  })

  it('uses chat.postMessage with a bot token and surfaces ok:false as an error', async () => {
    const r = recorder([{ body: JSON.stringify({ ok: true, channel: 'C1', ts: '1.2' }) }, { body: JSON.stringify({ ok: false, error: 'channel_not_found' }) }])
    const ch = new SlackChannel({ target: { kind: 'bot', token: 'xoxb-t', channel: 'alerts' }, fetchImpl: r.fetchImpl })
    const ref = await ch.send(approval)
    expect(ref.channelMessageId).toBe('C1:1.2')
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-t')
    await expect(ch.send(approval)).rejects.toThrow(/channel_not_found/)
  })

  it('edits the original message on resolution (bot mode)', async () => {
    const r = recorder([{ body: JSON.stringify({ ok: true }) }])
    const ch = new SlackChannel({ target: { kind: 'bot', token: 'xoxb-t', channel: 'alerts' }, fetchImpl: r.fetchImpl })
    await ch.updateMessage({ channelMessageId: 'C1:1.2' }, '✓ allowed in the TUI')
    expect(r.calls[0]!.url).toBe('https://slack.com/api/chat.update')
    expect(r.calls[0]!.body).toMatchObject({ channel: 'C1', ts: '1.2' })
  })
})

describe('DiscordChannel', () => {
  it('sends an embed with mentions disabled and waits for the message id', async () => {
    const r = recorder([{ body: JSON.stringify({ id: 'm-9' }) }])
    const ch = new DiscordChannel({ target: { kind: 'webhook', url: 'https://discord.com/api/webhooks/1/abc' }, fetchImpl: r.fetchImpl })
    const ref = await ch.send(approval)
    expect(ref.channelMessageId).toBe('m-9')
    expect(r.calls[0]!.url).toBe('https://discord.com/api/webhooks/1/abc?wait=true')
    expect(r.calls[0]!.body.allowed_mentions).toEqual({ parse: [] })
    expect(r.calls[0]!.body.embeds[0].color).toBe(0xff5252)
  })

  it('patches the webhook message on update and authenticates bots', async () => {
    const r = recorder([{}, { body: JSON.stringify({ id: 'm-1' }) }])
    const hook = new DiscordChannel({ target: { kind: 'webhook', url: 'https://discord.com/api/webhooks/1/abc' }, fetchImpl: r.fetchImpl })
    await hook.updateMessage({ channelMessageId: 'm-9' }, 'resolved')
    expect(r.calls[0]!.url).toBe('https://discord.com/api/webhooks/1/abc/messages/m-9')
    expect(r.calls[0]!.init.method).toBe('PATCH')
    const bot = new DiscordChannel({ target: { kind: 'bot', token: 'tok', channelId: '42' }, fetchImpl: r.fetchImpl })
    await bot.send(approval)
    expect(r.calls[1]!.url).toBe('https://discord.com/api/v10/channels/42/messages')
    expect((r.calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bot tok')
  })

  it('does not echo provider error bodies that may contain the webhook URL', async () => {
    const r = recorder([{ status: 404, body: 'Unknown Webhook https://discord.com/api/webhooks/1/SECRETTOKEN' }])
    const ch = new DiscordChannel({ target: { kind: 'webhook', url: 'https://discord.com/api/webhooks/1/abc' }, fetchImpl: r.fetchImpl })
    const err = await ch.send(approval).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChannelDeliveryError)
    expect(String(err)).not.toContain('SECRETTOKEN')
  })
})

describe('NtfyChannel', () => {
  it('publishes JSON with priority by level and an optional bearer token', async () => {
    const r = recorder()
    const ch = new NtfyChannel({ server: 'https://ntfy.example/', topic: 'foreman-abc', accessToken: 'tk_1', fetchImpl: r.fetchImpl })
    await ch.send(approval)
    expect(r.calls[0]!.url).toBe('https://ntfy.example')
    expect(r.calls[0]!.body).toMatchObject({ topic: 'foreman-abc', priority: 5, tags: ['rotating_light'] })
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tk_1')
  })
})

describe('channel factory', () => {
  const secrets = (values: Record<string, string>) => ({
    exists: (n: string) => n in values,
    get: (n: string) => values[n]!,
  })

  it('builds every channel the wizard can enable — Slack and Discord included', () => {
    const config = NotifyConfigSchema.parse({
      channels: {
        slack: { enabled: true, webhook_url_ref: 'slack-webhook' },
        discord: { enabled: true, bot_token_ref: 'discord-bot-token', channel: '123' },
        ntfy: { enabled: true, topic_ref: 'ntfy-topic' },
        email: { enabled: true, smtp_host: 'smtp.example.com', email_from: 'a@example.com', email_to: ['b@example.com'] },
      },
    })
    const { channels, problems } = buildEnabledChannels(config, {
      secrets: secrets({ 'slack-webhook': 'https://hooks.slack.com/x', 'discord-bot-token': 't', 'ntfy-topic': 'x' }),
    })
    expect([...channels.keys()].sort()).toEqual(['discord', 'email', 'ntfy', 'slack'])
    expect(problems).toEqual([])
  })

  it('explains what is missing instead of silently dropping the channel', () => {
    const noChannel = buildChannel('slack', { enabled: true, bot_token_ref: 'slack-bot-token' }, { secrets: secrets({}) })
    expect(noChannel).toMatchObject({ problem: expect.stringMatching(/webhook_url_ref .*bot_token_ref \+ channel/) })
    const noSecret = buildChannel('ntfy', { enabled: true, topic_ref: 'ntfy-topic' }, { secrets: secrets({}) })
    expect(noSecret).toMatchObject({ problem: expect.stringMatching(/foreman secrets add ntfy-topic/) })
  })

  it('keeps a webhook off, rather than unsigned, when its signing secret is missing', () => {
    const built = buildChannel(
      'webhook',
      { enabled: true, webhook_url_ref: 'hook-url', signing_secret_ref: 'hook-signing' },
      { secrets: secrets({ 'hook-url': 'https://example.com/hook' }) },
    )
    expect(built).toMatchObject({ problem: expect.stringMatching(/foreman secrets add hook-signing/) })
  })
})
