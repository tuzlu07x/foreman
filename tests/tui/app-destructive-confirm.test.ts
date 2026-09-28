import { afterEach, describe, expect, it } from 'vitest'
import { SecretStore } from '../../src/core/secret-store.js'
import { ESC, mountApp, type MountedApp } from '../support/tui-app.js'

// QA #657 H4 — `d` on Keys deleted the selected secret and `r` on Agents
// removed the selected agent on a single key press. Both now ask first,
// like the CLI does, and only `y` goes ahead.
describe('TUI destructive keys ask first', () => {
  let m: MountedApp
  let store: SecretStore
  afterEach(() => m.unmount())

  const mountWithSecretAndAgent = async (): Promise<void> => {
    m = await mountApp(({ db, registry }) => {
      store = new SecretStore(db, Buffer.alloc(32, 7))
      store.add('anthropic-key', 'sk-ant-test-value')
      registry.register({ id: 'claude-code', displayName: 'Claude Code', transport: 'stdio' })
      return { secretStore: store }
    })
  }

  it('Keys: d asks, n keeps the secret, y deletes it', async () => {
    await mountWithSecretAndAgent()
    await m.press('k')
    await m.press('d')
    expect(m.frame()).toContain('Delete secret "anthropic-key"?')
    expect(store.exists('anthropic-key')).toBe(true)
    await m.press('n')
    expect(m.frame()).not.toContain('Delete secret')
    expect(store.exists('anthropic-key')).toBe(true)

    await m.press('d')
    await m.press(ESC)
    expect(store.exists('anthropic-key')).toBe(true)

    await m.press('d')
    await m.press('y')
    expect(store.exists('anthropic-key')).toBe(false)
    expect(m.frame()).toContain('anthropic-key removed')
  })

  it('Agents: r no longer removes; x asks and says the binary stays', async () => {
    await mountWithSecretAndAgent()
    await m.press('a')
    await m.press('r')
    expect(m.registry.get('claude-code')).not.toBeNull()
    // `r` is "regenerate key", behind its own question.
    expect(m.frame()).toContain("Regenerate claude-code's keypair?")
    await m.press('n')

    await m.press('x')
    const frame = m.frame()
    expect(frame).toContain('Remove agent "claude-code"?')
    expect(frame).toContain('binary and config files stay installed')
    expect(m.registry.get('claude-code')).not.toBeNull()
    await m.press('q')
    expect(m.registry.get('claude-code')).not.toBeNull()

    await m.press('x')
    await m.press('y')
    expect(m.registry.get('claude-code')).toBeNull()
  })

  it('a regenerate only happens on y', async () => {
    await mountWithSecretAndAgent()
    const rotated: string[] = []
    m.bus.on('agent:key-rotated', (e) => rotated.push(e.agentId))
    await m.press('a')
    await m.press('r')
    await m.press('n')
    expect(rotated).toEqual([])
    await m.press('r')
    await m.press('y')
    expect(rotated).toEqual(['claude-code'])
    expect(m.frame()).toContain('new private key (shown once)')
  })
})
