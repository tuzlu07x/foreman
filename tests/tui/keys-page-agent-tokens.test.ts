import { afterEach, describe, expect, it } from 'vitest'
import { SecretStore } from '../../src/core/secret-store.js'
import { mountApp, type MountedApp } from '../support/tui-app.js'

// QA #657 (docs pass) — the Keys page listed the agents' identity tokens
// (`foreman-agent-token:*`, #618) and `d` deleted them.
describe('Keys page and agent identity tokens', () => {
  let m: MountedApp
  let store: SecretStore
  afterEach(() => m.unmount())

  const mount = async (withUserSecret: boolean): Promise<void> => {
    m = await mountApp(({ db }) => {
      store = new SecretStore(db, Buffer.alloc(32, 7))
      store.putReserved('foreman-agent-token:claude-code', 'fat_fake_token_value')
      if (withUserSecret) store.add('anthropic-key', 'sk-ant-fake')
      return { secretStore: store }
    })
    await m.press('k')
  }

  it('does not list them', async () => {
    await mount(true)
    const frame = m.frame()
    expect(frame).toContain('anthropic-key')
    expect(frame).toContain('1 stored')
    expect(frame).not.toContain('foreman-agent-token')
  })

  it('d can only reach your own secrets', async () => {
    await mount(true)
    await m.press('d')
    expect(m.frame()).toContain('Delete secret "anthropic-key"?')
    await m.press('y')
    expect(store.exists('anthropic-key')).toBe(false)
    await m.press('d')
    await m.press('y')
    expect(store.exists('foreman-agent-token:claude-code')).toBe(true)
  })

  it('with only tokens stored, the page is empty and d does nothing', async () => {
    await mount(false)
    expect(m.frame()).toContain('No secrets stored yet')
    await m.press('d')
    expect(m.frame()).not.toContain('Delete secret')
    await m.press('y')
    expect(store.exists('foreman-agent-token:claude-code')).toBe(true)
  })
})
