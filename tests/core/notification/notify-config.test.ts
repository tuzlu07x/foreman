import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  channelConfig,
  defaultNotifyConfig,
  isChannelEnabled,
  loadNotifyConfig,
  NotifyConfigSchema,
  routeFor,
  saveNotifyConfig,
} from '../../../src/core/notification/notify-config.js'

describe('notify-config — schema + defaults', () => {
  it('NotifyConfigSchema parses an empty object via defaults', () => {
    const parsed = NotifyConfigSchema.parse({})
    expect(parsed.channels).toEqual({})
    expect(parsed.routing).toEqual({})
  })

  it('rejects unknown top-level keys (.strict())', () => {
    expect(() => NotifyConfigSchema.parse({ foo: 'bar' })).toThrow()
  })

  it('defaultNotifyConfig ships sensible defaults for v0.1', () => {
    const config = defaultNotifyConfig()
    expect(config.channels.telegram?.enabled).toBe(false)
    const critical = routeFor(config, 'critical')
    expect(critical.timeout_seconds).toBe(300)
    expect(critical.default_action).toBe('deny')
    expect(critical.channels).toEqual(['telegram'])
  })

  it('routeFor returns an empty route for unknown / unconfigured levels', () => {
    const route = routeFor(NotifyConfigSchema.parse({}), 'info')
    expect(route.channels).toEqual([])
    expect(route.timeout_seconds).toBe(0)
  })

  it('isChannelEnabled honours enabled=true only', () => {
    const config = defaultNotifyConfig()
    expect(isChannelEnabled(config, 'telegram')).toBe(false)
    config.channels.telegram = { enabled: true, bot_token_ref: 'tg-token' }
    expect(isChannelEnabled(config, 'telegram')).toBe(true)
    expect(isChannelEnabled(config, 'discord')).toBe(false)
  })

  it('channelConfig returns null for unknown channels', () => {
    expect(channelConfig(NotifyConfigSchema.parse({}), 'telegram')).toBeNull()
  })

  it('rejects unknown channel-toggle keys (.strict())', () => {
    expect(() =>
      NotifyConfigSchema.parse({
        channels: { telegram: { enabled: true, surprise: 'no' } },
      }),
    ).toThrow()
  })

  it('coerces missing route bits with defaults', () => {
    const config = NotifyConfigSchema.parse({
      routing: { critical: { channels: ['telegram'] } },
    })
    expect(config.routing.critical?.timeout_seconds).toBe(0)
    expect(config.routing.critical?.default_action).toBe('deny')
  })
})

describe('notify-config — load + save', () => {
  let tmpDir: string
  let path: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'notify-cfg-'))
    path = join(tmpDir, 'notify.yaml')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('load returns defaults when file is absent', () => {
    const config = loadNotifyConfig(path)
    expect(config.channels.telegram?.enabled).toBe(false)
  })

  it('load handles an empty file gracefully', () => {
    writeFileSync(path, '', 'utf-8')
    const config = loadNotifyConfig(path)
    expect(config.channels.telegram?.enabled).toBe(false)
  })

  it('round-trips load → save → load', () => {
    const config = defaultNotifyConfig()
    config.channels.telegram = {
      enabled: true,
      bot_token_ref: 'tg-token',
      chat_id: '123456',
    }
    saveNotifyConfig(path, config)
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('telegram')
    expect(text).toContain('tg-token')
    const reloaded = loadNotifyConfig(path)
    expect(reloaded.channels.telegram?.enabled).toBe(true)
    expect(reloaded.channels.telegram?.chat_id).toBe('123456')
  })

  it('load merges user overrides with defaults (missing keys filled in)', () => {
    writeFileSync(
      path,
      'channels:\n  telegram:\n    enabled: true\n    bot_token_ref: tg-token\n    chat_id: "987"\n',
      'utf-8',
    )
    const config = loadNotifyConfig(path)
    expect(config.channels.telegram?.enabled).toBe(true)
    // Routing defaults still populated even though the file doesn't set them.
    expect(routeFor(config, 'critical').timeout_seconds).toBe(300)
  })

  it('throws when the YAML is malformed', () => {
    writeFileSync(path, 'channels: [bad-shape', 'utf-8')
    expect(() => loadNotifyConfig(path)).toThrow()
  })
})
