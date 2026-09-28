import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, type MountedApp } from '../support/tui-app.js'

// Every status bar says `? help`, and the help lists `h / ?` under
// "Everywhere", but only Home opened it: each page's key branch returned
// first (terminal QA, 2026-09-28).
describe('? opens help on every page', () => {
  let m: MountedApp
  afterEach(() => m.unmount())

  for (const [key, page] of [
    ['a', 'Agents'],
    ['g', 'Settings'],
    ['l', 'Logs'],
    ['p', 'Policy'],
    ['s', 'Sessions'],
    ['d', 'Delegations'],
    ['n', 'Inbox'],
  ] as const) {
    it(`${page} (${key})`, async () => {
      m = await mountApp(({ registry }) => {
        registry.register({ id: 'codex', displayName: 'Codex', transport: 'stdio' })
        return {}
      })
      await m.press(key, 150)
      expect(m.frame()).not.toContain('Everywhere')
      await m.press('?', 200)
      expect(m.frame()).toContain('Everywhere')
      await m.press('\u001B', 200)
      expect(m.frame()).not.toContain('Everywhere')
    })
  }
})
