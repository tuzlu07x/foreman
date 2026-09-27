import type { Key } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import type { WizardContext } from '../../src/tui/setup-wizard/context.js'
import { handleCtrlC, isModifiedLetter } from '../../src/tui/setup-wizard/quit.js'

// =============================================================================
// Ctrl/Meta + letter must never reach the wizard's single-letter hotkeys
// (Ctrl-C arrived as "c" and started the install from required-setup).
// Esc and arrows can carry `meta` in Ink but have an empty input.
// =============================================================================

function key(overrides: Partial<Key>): Key {
  return { ctrl: false, meta: false, escape: false, upArrow: false, ...overrides } as Key
}

describe('isModifiedLetter', () => {
  it('flags Ctrl+letter and Meta+letter', () => {
    expect(isModifiedLetter('c', key({ ctrl: true }))).toBe(true)
    expect(isModifiedLetter('s', key({ meta: true }))).toBe(true)
    expect(isModifiedLetter('Q', key({ ctrl: true }))).toBe(true)
  })

  it('leaves plain letters alone', () => {
    expect(isModifiedLetter('c', key({}))).toBe(false)
  })

  it('leaves Esc and arrows alone even when Ink marks them meta', () => {
    expect(isModifiedLetter('', key({ escape: true, meta: true }))).toBe(false)
    expect(isModifiedLetter('', key({ upArrow: true, meta: true }))).toBe(false)
  })
})

// Ctrl-C on the install screen: refused (with a notice) while the runner
// is still going or a failure prompt waits on the user; allowed once the
// runner has settled — a crashed runner used to leave Ctrl-C refused.
describe('handleCtrlC on the install step', () => {
  function ctx(opts: { settled: boolean; pending?: boolean; resolver?: boolean }): {
    ctx: WizardContext
    quit: ReturnType<typeof vi.fn>
    notice: ReturnType<typeof vi.fn>
  } {
    const quit = vi.fn()
    const notice = vi.fn()
    const c = {
      currentStep: 'install',
      quit,
      state: {
        installSettled: opts.settled,
        pendingFailure: opts.pending ? { agentId: 'hermes' } : null,
      },
      set: { setInstallQuitNotice: notice },
      failureResolverRef: { current: opts.resolver ? () => undefined : null },
    } as unknown as WizardContext
    return { ctx: c, quit, notice }
  }

  it('shows the notice while the runner is still going', () => {
    const t = ctx({ settled: false })
    handleCtrlC(t.ctx)
    expect(t.quit).not.toHaveBeenCalled()
    expect(t.notice).toHaveBeenCalledWith(true)
  })

  it('shows the notice while a failure prompt waits on the user', () => {
    const t = ctx({ settled: false, pending: true, resolver: true })
    handleCtrlC(t.ctx)
    expect(t.quit).not.toHaveBeenCalled()
    expect(t.notice).toHaveBeenCalledWith(true)
  })

  it('quits once the runner has settled and nothing waits on the user', () => {
    const t = ctx({ settled: true })
    handleCtrlC(t.ctx)
    expect(t.quit).toHaveBeenCalledTimes(1)
    expect(t.notice).not.toHaveBeenCalled()
  })
})
