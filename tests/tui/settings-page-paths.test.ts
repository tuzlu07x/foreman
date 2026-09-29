import { homedir } from 'node:os'
import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { DashboardProvider } from '../../src/tui/dashboard-context.js'
import { displayPath } from '../../src/tui/format.js'
import { buildSettingsItems, SettingsPage, settingsDetail } from '../../src/tui/pages/settings-page.js'

// TUI tour: the Settings page printed long absolute paths and jargon
// ("all agents receive secrets").

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('displayPath', () => {
  it('shows the home directory as ~', () => {
    expect(displayPath('/Users/ada/.config/foreman/policy.yaml', 80, '/Users/ada')).toBe('~/.config/foreman/policy.yaml')
    expect(displayPath('/Users/adam/x', 80, '/Users/ada')).toBe('/Users/adam/x')
    expect(displayPath('/etc/foreman/policy.yaml', 80, '/Users/ada')).toBe('/etc/foreman/policy.yaml')
  })

  it('cuts the middle out of a path too long for the width, keeping the file name', () => {
    const long = '/Users/ada/Library/Application Support/foreman/some/deeply/nested/folder/policy.yaml'
    const shown = displayPath(long, 40, '/Users/ada')
    expect(shown.length).toBeLessThanOrEqual(40)
    expect(shown.startsWith('~/')).toBe(true)
    expect(shown.endsWith('/folder/policy.yaml')).toBe(true)
    expect(shown).toContain('…')
  })
})

describe('Settings page', () => {
  it('shows paths from home as ~ and fitted to the terminal', () => {
    const soul = `${homedir()}/Library/Application Support/foreman/a/really/long/path/that/goes/on/and/on/SOUL.md`
    const [item] = buildSettingsItems(soul, null)
    const shown = settingsDetail(item!, 60)
    expect(shown.startsWith('~/')).toBe(true)
    expect(shown.endsWith('SOUL.md')).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(50)
    // Keys and actions are unchanged.
    expect(buildSettingsItems(soul, `${homedir()}/policy.yaml`).map((i) => [i.key, i.action])).toEqual([
      ['e', 'edit-soul'],
      ['p', 'edit-policy'],
      ['P', 'open-policy'],
      ['w', 'wizard-instruction'],
    ])
  })

  it('says in plain words what the chat-agent setting means', async () => {
    const { db, sqlite } = createInMemoryDb()
    const bus = new EventBus<ForemanEventMap>()
    const registry = new RegistryService(db, bus)
    const app = render(
      React.createElement(DashboardProvider, {
        db,
        sqlite,
        bus,
        registry,
        policyPath: `${homedir()}/.config/foreman/policy.yaml`,
        children: React.createElement(SettingsPage, { selectedIdx: 0, notice: null }),
      }),
    )
    try {
      await tick()
      const frame = strip(app.lastFrame())
      expect(frame).toContain('~/.config/foreman/policy.yaml')
      expect(frame).not.toContain(homedir())
      expect(frame).toContain("Which agent gets each chat app's bot token")
      expect(frame).toContain('telegram ○ none picked — every chat agent using it gets the token')
      expect(frame).not.toContain('all agents receive secrets')
    } finally {
      app.unmount()
      sqlite.close()
    }
  })
})
