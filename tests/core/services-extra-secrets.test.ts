import { describe, expect, it } from 'vitest'
import {
  loadBundledServices,
  parseServiceCatalogText,
} from '../../src/core/registry-catalog.js'

// =============================================================================
// Regression for #220 — Telegram setup must collect both the bot token AND
// the chat id. This file pins:
//   1) the schema accepts (and defaults) `extra_secrets` on a service
//   2) the bundled registry has the Telegram chat-id extra
//   3) parsing rejects malformed `extra_secrets` entries
// =============================================================================

describe('ServiceEntry — extra_secrets schema (#220)', () => {
  it('defaults extra_secrets to [] when omitted (back-compat)', () => {
    const text = JSON.stringify({
      version: 1,
      services: [
        {
          id: 'telegram',
          name: 'Telegram',
          description: 'Bot',
          secret_name: 'telegram-bot-token',
          where_to_get: 'https://t.me/BotFather',
          format_hint: '123:abc',
          setup_steps: ['x'],
          used_by_agents: [],
          open_url_hotkey: true,
        },
      ],
    })
    const parsed = parseServiceCatalogText(text)
    expect(parsed.services[0]!.extra_secrets).toEqual([])
  })

  it('parses extra_secrets with all fields (where_to_get nullable)', () => {
    const text = JSON.stringify({
      version: 1,
      services: [
        {
          id: 'telegram',
          name: 'Telegram',
          description: 'Bot',
          secret_name: 'telegram-bot-token',
          where_to_get: 'https://t.me/BotFather',
          format_hint: '123:abc',
          setup_steps: ['x'],
          used_by_agents: [],
          open_url_hotkey: true,
          extra_secrets: [
            {
              name: 'telegram-chat-id',
              description: 'Where to send',
              format_hint: '-1001234567890',
              where_to_get: null,
              setup_steps: ['Open Telegram', 'Get the chat id'],
              optional: true,
            },
          ],
        },
      ],
    })
    const parsed = parseServiceCatalogText(text)
    const extras = parsed.services[0]!.extra_secrets
    expect(extras).toHaveLength(1)
    expect(extras[0]).toMatchObject({
      name: 'telegram-chat-id',
      format_hint: '-1001234567890',
      where_to_get: null,
      optional: true,
    })
  })

  it('rejects an extra_secrets entry missing setup_steps', () => {
    const text = JSON.stringify({
      version: 1,
      services: [
        {
          id: 'telegram',
          name: 'Telegram',
          description: 'Bot',
          secret_name: 'telegram-bot-token',
          where_to_get: 'https://t.me/BotFather',
          format_hint: '123:abc',
          setup_steps: ['x'],
          used_by_agents: [],
          open_url_hotkey: true,
          extra_secrets: [
            {
              name: 'telegram-chat-id',
              format_hint: '-1001234567890',
              // missing setup_steps
            },
          ],
        },
      ],
    })
    expect(() => parseServiceCatalogText(text)).toThrow()
  })
})

describe('bundled registry — Telegram has chat-id extra (#220)', () => {
  it('Telegram service ships with a telegram-chat-id extra', () => {
    const catalog = loadBundledServices()
    const telegram = catalog.services.find((s) => s.id === 'telegram')
    expect(telegram, 'telegram service missing from registry').toBeDefined()
    const chatIdExtra = telegram!.extra_secrets.find(
      (e) => e.name === 'telegram-chat-id',
    )
    expect(chatIdExtra, 'telegram-chat-id extra missing — #220 regressed').toBeDefined()
    expect(chatIdExtra!.optional).toBe(true)
    expect(chatIdExtra!.setup_steps.length).toBeGreaterThan(0)
    expect(chatIdExtra!.format_hint).toContain('-100')
  })
})
