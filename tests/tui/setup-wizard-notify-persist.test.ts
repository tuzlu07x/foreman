import { describe, expect, it } from 'vitest'
import { defaultNotifyConfig } from '../../src/core/notification/notify-config.js'
import type { ServiceEntry } from '../../src/core/registry-catalog.js'
import {
  buildNotifyConfigFromWizard,
  type SecretReader,
} from '../../src/tui/setup-wizard-notify-persist.js'

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
    where_to_get: null,
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

  it('enables discord when only the bot token was saved', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['discord-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual(['discord'])
    expect(result.next.channels.discord?.enabled).toBe(true)
    expect(result.next.channels.discord?.bot_token_ref).toBe(
      'discord-bot-token',
    )
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
    })
    expect(result.wiredChannels.sort()).toEqual(
      ['discord', 'slack', 'telegram'].sort(),
    )
    expect(result.next.channels.telegram?.enabled).toBe(true)
    expect(result.next.channels.discord?.enabled).toBe(true)
    expect(result.next.channels.slack?.enabled).toBe(true)
  })

  it('telegram without chat_id still enables with bot_token_ref (chat_id undefined)', () => {
    const result = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing: defaultNotifyConfig(),
    })
    expect(result.wiredChannels).toEqual(['telegram'])
    expect(result.next.channels.telegram?.enabled).toBe(true)
    expect(result.next.channels.telegram?.bot_token_ref).toBe(
      'telegram-bot-token',
    )
    expect(result.next.channels.telegram?.chat_id).toBeUndefined()
  })

  it('tolerates secretStore.get throwing for chat_id — leaves chat_id unset', () => {
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
    expect(result.wiredChannels).toEqual(['telegram'])
    expect(result.next.channels.telegram?.enabled).toBe(true)
    expect(result.next.channels.telegram?.chat_id).toBeUndefined()
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
      savedStorageNames: ['telegram-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
      existing,
    })
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
      savedStorageNames: ['telegram-bot-token'],
      serviceCatalog: CATALOG,
      secretStore: makeReader({}),
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
