import { afterEach, describe, expect, it } from 'vitest'
import { pickerOptions } from '../../src/tui/components/model-picker.js'
import { mountApp, type MountedApp } from '../support/tui-app.js'

describe('model picker options', () => {
  it('lists the tiers first, then live models, marks the current one, and can offer the default', () => {
    const opts = pickerOptions(
      [
        { id: 'claude-haiku-4-5', hint: 'fast, cheapest' },
        { id: 'claude-sonnet-5', hint: 'balanced' },
      ],
      ['claude-fable-5-1', 'claude-sonnet-5'],
      'claude-sonnet-5',
      true,
    )
    expect(opts.map((o) => o.value)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-fable-5-1', '__clear__'])
    expect(opts[1]!.label).toBe('claude-sonnet-5 — balanced ✓')
    expect(opts.at(-1)!.label).toBe('back to the default')
  })
})

describe('model picker in the TUI', () => {
  let m: MountedApp
  afterEach(() => m.unmount())

  it("opens on the Agents page with m, lists the tiers and runs `model <agent> <id>`", async () => {
    const dispatched: string[][] = []
    m = await mountApp(({ registry }) => {
      registry.register({ id: 'claude-code', displayName: 'Claude Code', transport: 'stdio' })
      return {
        commandRouter: {
          dispatch: async (verb: string, args: string[]) => {
            dispatched.push([verb, ...args])
            return { ok: true, text: 'claude-code now runs claude-sonnet-5' }
          },
          listVerbs: () => ['model'],
        } as never,
        commandContext: {} as never,
      }
    })
    await m.press('a', 100)
    await m.press('m', 150)
    const frame = m.frame()
    expect(frame).toContain("claude-code's model (anthropic)")
    expect(frame).toContain('claude-haiku-4-5 — fast, cheapest')
    expect(frame).toContain('claude-fable-5-1 — most capable')
    await m.press('\u001B[B', 80) // ↓ to balanced
    await m.press('\r', 200)
    expect(dispatched).toEqual([['model', 'claude-code', 'claude-sonnet-5']])
    expect(m.frame()).toContain('claude-code now runs claude-sonnet-5')
  })

  it('Esc closes it without changing anything', async () => {
    m = await mountApp(({ registry }) => {
      registry.register({ id: 'codex', displayName: 'Codex', transport: 'stdio' })
      return {}
    })
    await m.press('a', 100)
    await m.press('m', 150)
    expect(m.frame()).toContain("codex's model (openai)")
    await m.press('\u001B', 150)
    expect(m.frame()).not.toContain("codex's model")
  })
})
