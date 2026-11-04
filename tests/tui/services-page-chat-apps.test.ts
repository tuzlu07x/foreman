import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { NotifyConfigSchema } from '../../src/core/notification/notify-config.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { DashboardProvider } from '../../src/tui/dashboard-context.js'
import { chatAppMode, ServicesPage } from '../../src/tui/pages/services-page.js'

// TUI tour: the Services page still listed GitHub, Jira and Notion (now on
// the Integrations page) and didn't say how each chat app is set up.

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))
const config = (channels: Record<string, unknown>) => NotifyConfigSchema.parse({ channels })

describe('chat app mode', () => {
  it('Telegram: one bot Foreman reads, or a chat agent reads it', () => {
    const on = { enabled: true, bot_token_ref: 'telegram-bot-token', chat_id: '1' }
    expect(chatAppMode('telegram', config({ telegram: on }), []).label).toMatch(/^one bot — Foreman reads it/)
    expect(chatAppMode('telegram', config({ telegram: { ...on, listener: 'foreman' } }), ['hermes']).label).toMatch(
      /^one bot/,
    )
    const shared = chatAppMode('telegram', config({ telegram: on }), ['hermes'])
    expect(shared).toEqual({
      label: 'chat agent reads it (hermes) — Foreman only sends',
      change: 'foreman notify approval-bot',
    })
    expect(chatAppMode('telegram', config({ telegram: { ...on, listener: 'agent' } }), []).label).toBe(
      'chat agent reads it — Foreman only sends',
    )
    expect(
      chatAppMode('telegram', config({ telegram: { ...on, approval_bot_token_ref: 'telegram-approval-bot-token' } }), [
        'hermes',
      ]).label,
    ).toMatch(/second bot only Foreman reads/)
  })

  it('Slack and Discord: two-way or notifications only', () => {
    expect(chatAppMode('slack', config({ slack: { enabled: true, app_token_ref: 'slack-app-token' } }), []).label).toMatch(
      /^two-way \(Socket Mode/,
    )
    expect(chatAppMode('slack', config({ slack: { enabled: true } }), [])).toEqual({
      label: 'notifications only',
      change: 'foreman notify slack-interactive',
    })
    expect(chatAppMode('discord', config({ discord: { enabled: true, interactive: true } }), []).label).toMatch(/^two-way/)
    expect(chatAppMode('discord', config({ discord: { enabled: true } }), []).change).toBe(
      'foreman notify discord-interactive',
    )
  })

  it('a chat app not turned on in notify.yaml says how to turn it on', () => {
    expect(chatAppMode('discord', config({}), [])).toEqual({
      label: 'not sending notifications yet',
      change: 'foreman notify enable discord',
    })
  })
})

describe('Services page', () => {
  let home: string
  let previousHome: string | undefined
  beforeEach(() => {
    previousHome = process.env.FOREMAN_HOME
    home = mkdtempSync(join(tmpdir(), 'foreman-services-page-'))
    process.env.FOREMAN_HOME = home
  })
  afterEach(() => {
    process.env.FOREMAN_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('lists only chat apps, each with its mode', async () => {
    writeFileSync(
      join(home, 'notify.yaml'),
      [
        'channels:',
        '  telegram: { enabled: true, bot_token_ref: telegram-bot-token, chat_id: "1", listener: foreman }',
        '  slack: { enabled: true, bot_token_ref: slack-bot-token, channel: "#ops" }',
        '',
      ].join('\n'),
    )
    const { db, sqlite } = createInMemoryDb()
    const bus = new EventBus<ForemanEventMap>()
    const registry = new RegistryService(db, bus)
    const secretStore = new SecretStore(db, Buffer.alloc(32, 7))
    secretStore.add('telegram-bot-token', '123456:abc')
    secretStore.add('slack-bot-token', 'xoxb-1')
    const app = render(
      React.createElement(DashboardProvider, {
        db,
        sqlite,
        bus,
        registry,
        secretStore,
        children: React.createElement(ServicesPage, { onLeave: () => {} }),
      }),
    )
    try {
      await tick()
      const frame = strip(app.lastFrame())
      expect(frame).toContain('Telegram one bot — Foreman reads it')
      expect(frame).toContain('Slack notifications only')
      expect(frame).toContain('Discord not set up')
      expect(frame).not.toMatch(/[●○] (GitHub|Atlassian|Notion)/)
      expect(frame).toContain('GitHub, Jira, Notion and other tools are on the Integrations page')
      // Enter shows how to change the mode; the actions still work.
      for (let i = 0; i < 2; i++) {
        app.stdin.write('\u001B[B')
        await tick()
      }
      app.stdin.write('\r')
      await tick()
      expect(strip(app.lastFrame())).toContain('change mode:  foreman notify slack-interactive')
      app.stdin.write('w')
      await tick()
      expect(strip(app.lastFrame())).toContain('Slack guide')
      expect(strip(app.lastFrame())).toContain('Approve from Slack:')
      // No secret value is shown unless asked for.
      expect(strip(app.lastFrame())).not.toContain('xoxb-1')
    } finally {
      app.unmount()
      sqlite.close()
    }
  })

  it('t sends a test and says what happened; a token alone is not called connected', async () => {
    writeFileSync(
      join(home, 'notify.yaml'),
      ['channels:', '  telegram: { enabled: true, bot_token_ref: telegram-bot-token, chat_id: "1", listener: foreman }', ''].join('\n'),
    )
    const { db, sqlite } = createInMemoryDb()
    const bus = new EventBus<ForemanEventMap>()
    const secretStore = new SecretStore(db, Buffer.alloc(32, 7))
    secretStore.add('telegram-bot-token', '123456:abc')
    // Stored by the old flow: a token, and no channel.
    secretStore.add('slack-bot-token', 'xoxb-1')
    let answer: { ok: true } | { ok: false; reason: string } = { ok: true }
    const tested: string[] = []
    const api = {
      checkToken: async () => ({ status: 'ok' as const, value: { username: null } }),
      checkSlackAppToken: async () => ({ status: 'ok' as const, value: null }),
      findTelegramChat: async () => ({ status: 'ok' as const, value: null }),
      test: async (id: string) => {
        tested.push(id)
        return answer
      },
    }
    const app = render(
      React.createElement(DashboardProvider, {
        db,
        sqlite,
        bus,
        registry: new RegistryService(db, bus),
        secretStore,
        children: React.createElement(ServicesPage, { onLeave: () => {}, api }),
      }),
    )
    try {
      await tick()
      const frame = strip(app.lastFrame())
      expect(frame).toContain('1 connected')
      expect(frame).toContain('token saved, not sending yet')
      app.stdin.write('t')
      await tick(120)
      expect(tested).toEqual(['telegram'])
      expect(strip(app.lastFrame())).toContain('Test message sent to Telegram')
      answer = { ok: false, reason: 'Telegram rejected the bot token.' }
      app.stdin.write('t')
      await tick(120)
      expect(strip(app.lastFrame())).toContain('Telegram rejected the bot token.')
      // The half-set app offers to finish, and has nothing to test.
      for (let i = 0; i < 2; i++) {
        app.stdin.write('\u001B[B')
        await tick()
      }
      app.stdin.write('t')
      await tick(120)
      expect(tested).toHaveLength(2)
      expect(strip(app.lastFrame())).toContain('[n] finish setup')
      app.stdin.write('n')
      await tick()
      expect(strip(app.lastFrame())).toContain('Set up Slack')
    } finally {
      app.unmount()
      sqlite.close()
    }
  })
})
