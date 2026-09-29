import { describe, expect, it } from 'vitest'
import { buildChannel } from '../../../src/core/notification/channel-factory.js'
import { TelegramChannel } from '../../../src/core/notification/channels/telegram.js'
import { agentsSharingTelegram, resolveTelegramListener } from '../../../src/core/notification/telegram-listener.js'

// One Telegram bot is enough (#716): Foreman reads the main bot itself
// unless a chat agent (Hermes, OpenClaw) may be reading it.

const CATALOG = [
  { id: 'hermes', chat_capable: true, optional_services: ['telegram', 'discord'] },
  { id: 'openclaw', chat_capable: true, optional_services: ['telegram', 'discord', 'slack'] },
  { id: 'claude-code', optional_services: ['github'] },
  { id: 'zeroclaw', chat_capable: true },
]
const agent = (id: string, over: { status?: 'active' | 'blocked' | 'disabled' | 'inactive'; registryId?: string } = {}) => ({
  id,
  status: over.status ?? ('active' as const),
  metadata: over.registryId ? { registryId: over.registryId } : null,
})

describe('who reads the Telegram bot', () => {
  it('only chat agents that can use Telegram share the bot', () => {
    expect(agentsSharingTelegram([agent('claude-code'), agent('codex'), agent('zeroclaw')], CATALOG)).toEqual([])
    expect(agentsSharingTelegram([agent('claude-code'), agent('hermes')], CATALOG)).toEqual(['hermes'])
    // Registered under another name: its catalog entry decides.
    expect(agentsSharingTelegram([agent('ops-bot', { registryId: 'openclaw' })], CATALOG)).toEqual(['ops-bot'])
    // A blocked or disabled agent reads nothing.
    expect(agentsSharingTelegram([agent('hermes', { status: 'blocked' }), agent('openclaw', { status: 'disabled' })], CATALOG)).toEqual([])
  })

  it('Foreman reads it unless an agent may, and notify.yaml can say otherwise', () => {
    expect(resolveTelegramListener({}, [])).toBe('foreman')
    expect(resolveTelegramListener({}, ['hermes'])).toBe('agent')
    expect(resolveTelegramListener({ listener: 'foreman' }, ['hermes'])).toBe('foreman')
    expect(resolveTelegramListener({ listener: 'agent' }, [])).toBe('agent')
  })

  const build = (toggle: Record<string, unknown>, sharedWith?: string[]) => {
    const built = buildChannel(
      'telegram',
      { enabled: true, bot_token_ref: 'telegram-bot-token', chat_id: '424242', ...toggle },
      {
        secrets: { exists: () => true, get: (n: string) => `token-of-${n}` },
        signApproval: () => 'relay',
        signButton: () => 'button',
        onChatCommand: async () => 'ok',
        ...(sharedWith ? { telegramSharedWith: sharedWith } : {}),
      },
    )
    if (!('channel' in built)) throw new Error(built.problem)
    return built.channel as TelegramChannel
  }

  it('builds one bot that Foreman reads when no agent shares it', () => {
    expect(build({}).readsUpdates).toBe(true)
    expect(build({}, []).readsUpdates).toBe(true)
  })

  it('stays send-only on a bot a chat agent reads, unless there is an approval bot', () => {
    expect(build({}, ['hermes']).readsUpdates).toBe(false)
    expect(build({ approval_bot_token_ref: 'telegram-approval-bot-token' }, ['hermes']).readsUpdates).toBe(true)
    expect(build({ listener: 'agent' }).readsUpdates).toBe(false)
  })
})
