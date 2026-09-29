import { describe, expect, it } from 'vitest'
import { buildChannel } from '../../src/core/notification/channel-factory.js'
import { defaultNotifyConfig } from '../../src/core/notification/notify-config.js'
import type { ServiceEntry } from '../../src/core/registry-catalog.js'
import {
  buildNotifyConfigFromWizard,
  type SecretReader,
} from '../../src/tui/setup-wizard-notify-persist.js'
import { notifyWiringNames } from '../../src/tui/setup-wizard/services-logic.js'

// =============================================================================
// Pure-logic tests for #290 — wizard → notify.yaml persistence
// =============================================================================
//
// The bug: setup wizard collected bot tokens + chat ids, stashed them in the
// secret vault, summary said "✓ 2 services telegram, github" — but
// notify.yaml never landed on disk. `foreman notify test telegram` then
// returned "telegram is not enabled — run `foreman notify enable telegram`
// first" despite the wizard "succeeding".

function svc(overrides: Partial<ServiceEntry>): ServiceEntry {
  return {
    id: 'telegram',
    name: 'Telegram',
    description: 'desc',
    secret_name: 'telegram-bot-token',
    where_to_get: 'https://t.me/BotFather',
    format_hint: 'token',
    setup_steps: [],
    used_by_agents: [],
    open_url_hotkey: false,
    extra_secrets: [],
    ...overrides,
  }
}

const TELEGRAM: ServiceEntry = svc({
  id: 'telegram',
  secret_name: 'telegram-bot-token',
  extra_secrets: [
    {
      name: 'telegram-chat-id',
      description: 'chat id',
      format_hint: '12345',
      where_to_get: null,
      setup_steps: [],
      optional: true,
    },
  ],
})

const DISCORD: ServiceEntry = svc({
  id: 'discord',
  name: 'Discord',
  secret_name: 'discord-bot-token',
})

const SLACK: ServiceEntry = svc({
  id: 'slack',
  name: 'Slack',
  secret_name: 'slack-bot-token',
})

const GITHUB: ServiceEntry = svc({
  id: 'github',
  name: 'GitHub',
  secret_name: 'github-pat',
})

const NOTION: ServiceEntry = svc({
  id: 'notion',
  name: 'Notion',
  secret_name: 'notion-integration-token',
})

const CATALOG = [TELEGRAM, DISCORD, SLACK, GITHUB, NOTION]

function makeReader(map: Record<string, string>): SecretReader {
  return {
    get(name) {
      if (!(name in map)) throw new Error(`fake reader: no '${name}'`)
      return map[name]!
    },
  }
}

describe('buildNotifyConfigFromWizard — happy path', () => {
  it('enables telegram with bot_token_ref + inline chat_id from store', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'telegram-chat-id'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '8263464163' }),
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual(['telegram'])
    expect(result.next.channels.telegram?.enabled).toBe(true)
    expect(result.next.channels.telegram?.bot_token_ref).toBe(
      'telegram-bot-token',
    )
    expect(result.next.channels.telegram?.chat_id).toBe('8263464163')
  })

  it('enables discord with the bot token and the channel id the wizard asked for', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['discord-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing: defaultNotifyConfig(),
      channelTargets: { discord: '123456789012345678' },
    })
    expect(result.wiredChannels).toEqual(['discord'])
    expect(result.unwiredChannels).toEqual([])
    expect(result.next.channels.discord).toEqual({
      enabled: true,
      bot_token_ref: 'discord-bot-token',
      channel: '123456789012345678',
    })
  })

  it('enables slack in bot mode with its channel (what `notify enable slack --channel` writes)', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['slack-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing: defaultNotifyConfig(),
      channelTargets: { slack: '#foreman' },
    })
    expect(result.next.channels.slack).toEqual({
      enabled: true,
      bot_token_ref: 'slack-bot-token',
      channel: '#foreman',
    })
  })

  it('enables multiple channels when multiple services saved', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: [
        'telegram-bot-token',
        'telegram-chat-id',
        'discord-bot-token',
        'slack-bot-token',
      ],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '12345' }),
      existing: defaultNotifyConfig(),
      channelTargets: { slack: '#foreman', discord: '123456789012345678' },
    })
    expect(result.wiredChannels.sort()).toEqual(
      ['discord', 'slack', 'telegram'].sort(),
    )
    expect(result.next.channels.telegram?.enabled).toBe(true)
    expect(result.next.channels.discord?.enabled).toBe(true)
    expect(result.next.channels.slack?.enabled).toBe(true)
  })

  it('tolerates secretStore.get throwing for chat_id — leaves telegram off', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'telegram-chat-id'],
      serviceCatalog: CATALOG,
      secretStore: {
        get: () => {
          throw new Error('boom')
        },
      },
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual([])
    expect(result.next.channels.telegram?.enabled).toBe(false)
    expect(result.unwiredChannels.map((c) => c.channel)).toEqual(['telegram'])
  })
})

// Real-user test: a skipped chat id / channel still left the chat app
// `enabled: true` with only bot_token_ref, and `foreman doctor` warned
// ("slack needs webhook_url_ref … or bot_token_ref + channel").
describe('buildNotifyConfigFromWizard — never enables a half-configured channel', () => {
  it('leaves telegram off without a chat id and says how to finish', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual([])
    expect(result.next.channels.telegram?.enabled).toBe(false)
    expect(result.unwiredChannels).toEqual([
      { channel: 'telegram', missing: 'chat id', finish: 'foreman notify enable telegram --chat-id <id>' },
    ])
  })

  it('leaves slack and discord off without a channel, keeping the others', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'telegram-chat-id', 'slack-bot-token', 'discord-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '12345' }),
      existing: defaultNotifyConfig(),
      channelTargets: { slack: '  ' },
    })
    expect(result.wiredChannels).toEqual(['telegram'])
    expect(result.next.channels.slack).toBeUndefined()
    expect(result.next.channels.discord).toBeUndefined()
    expect(result.unwiredChannels).toEqual([
      { channel: 'discord', missing: 'channel id', finish: 'foreman notify enable discord --channel <channel-id>' },
      { channel: 'slack', missing: 'channel', finish: "foreman notify enable slack --channel '#foreman'" },
    ])
  })

  it('does not enable a service whose token was skipped', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-chat-id'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '12345' }),
      existing: defaultNotifyConfig(),
      channelTargets: { slack: '#foreman' },
    })
    expect(result.wiredChannels).toEqual([])
    expect(result.unwiredChannels).toEqual([])
    expect(result.next.channels.slack).toBeUndefined()
  })

  it('keeps the chat id / channel notify.yaml already has when the prompt was skipped', () => {
    const existing = defaultNotifyConfig()
    existing.channels.telegram = { enabled: true, bot_token_ref: 'telegram-bot-token', chat_id: '777' }
    existing.channels.discord = { enabled: false, bot_token_ref: 'discord-bot-token', channel: '123456789012345678' }
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'discord-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing,
    })
    expect(result.wiredChannels.sort()).toEqual(['discord', 'telegram'])
    expect(result.next.channels.telegram?.chat_id).toBe('777')
    expect(result.next.channels.discord).toEqual({
      enabled: true,
      bot_token_ref: 'discord-bot-token',
      channel: '123456789012345678',
    })
  })

  it('produces channels that the channel factory (doctor) can build', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'telegram-chat-id', 'slack-bot-token', 'discord-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '12345' }),
      existing: defaultNotifyConfig(),
      channelTargets: { slack: '#foreman', discord: '123456789012345678' },
    })
    const secrets = { exists: () => true, get: () => 'fake-secret-value' }
    for (const id of ['telegram', 'slack', 'discord'] as const) {
      expect(buildChannel(id, result.next.channels[id]!, { secrets })).not.toHaveProperty('problem')
    }
  })
})

describe('buildNotifyConfigFromWizard — non-channel services', () => {
  it('does NOT wire github (it is an agent secret, not a notify channel)', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['github-pat'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual([])
  })

  it('does NOT wire notion / atlassian / similar non-channel services', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['notion-integration-token', 'github-pat'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual([])
  })

  it('mixed save: enables telegram, ignores github', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: [
        'telegram-bot-token',
        'telegram-chat-id',
        'github-pat',
      ],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '99' }),
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual(['telegram'])
  })
})

describe('buildNotifyConfigFromWizard — no-op + merge semantics', () => {
  it('returns existing config unchanged when wizard saved nothing', () => {
    const existing = defaultNotifyConfig()
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: [],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing,
    })
    expect(result.wiredChannels).toEqual([])
    expect(result.next).toBe(existing) // pointer identity — no copy
  })

  it('preserves the existing routing block (user overrides survive)', () => {
    const existing = defaultNotifyConfig()
    existing.routing.critical = {
      channels: ['discord'],
      timeout_seconds: 600,
      default_action: 'allow',
    }
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'telegram-chat-id'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '12345' }),
      existing,
    })
    expect(result.wiredChannels).toEqual(['telegram'])
    expect(result.next.routing.critical?.channels).toEqual(['discord'])
    expect(result.next.routing.critical?.timeout_seconds).toBe(600)
    expect(result.next.routing.critical?.default_action).toBe('allow')
  })

  it('preserves a user-configured channel that the wizard did NOT touch', () => {
    const existing = defaultNotifyConfig()
    existing.channels.slack = {
      enabled: true,
      bot_token_ref: 'my-custom-slack-token',
      channel: 'C012345',
    }
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'telegram-chat-id'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({ 'telegram-chat-id': '12345' }),
      existing,
    })
    expect(result.next.channels.slack?.bot_token_ref).toBe(
      'my-custom-slack-token',
    )
    expect(result.next.channels.slack?.channel).toBe('C012345')
    expect(result.next.channels.telegram?.enabled).toBe(true)
  })

  it('does NOT touch routing or channels for skipped services on no-op', () => {
    const existing = defaultNotifyConfig()
    existing.channels.telegram = { enabled: false }
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: [],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing,
    })
    expect(result.next.channels.telegram?.enabled).toBe(false)
  })
})

// QA #657 M10 — a chat id entered for a bot token stored in an earlier run
// (or a resumed run, which starts with nothing saved) never reached
// notify.yaml.
describe('notifyWiringNames', () => {
  const catalog = [
    {
      id: 'telegram',
      secret_name: 'telegram-bot-token',
      extra_secrets: [{ name: 'telegram-chat-id' }],
    },
    { id: 'github', secret_name: 'github-pat' },
  ] as never
  const vault = (names: string[]) => ({ exists: (n: string) => names.includes(n) })

  it('adds the selected services’ secrets already in the vault', () => {
    expect(
      notifyWiringNames(['telegram'], ['telegram-chat-id'], catalog, vault(['telegram-bot-token', 'telegram-chat-id'])).sort(),
    ).toEqual(['telegram-bot-token', 'telegram-chat-id'])
  })

  it('leaves unselected services alone', () => {
    expect(notifyWiringNames([], [], catalog, vault(['telegram-bot-token', 'telegram-chat-id']))).toEqual([])
  })
})
