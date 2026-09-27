import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/tui/setup-wizard/install-runner.js', () => ({
  runInstallStep: vi.fn(() => new Promise(() => undefined)),
}))

import { freshState } from '../../src/tui/setup-state.js'
import type { WizardContext } from '../../src/tui/setup-wizard/context.js'
import { renderInstallStep } from '../../src/tui/setup-wizard/install.js'
import { runInstallStep } from '../../src/tui/setup-wizard/install-runner.js'
import {
  buildWizardSetters,
  createInitialWizardState,
  type WizardState,
} from '../../src/tui/setup-wizard/state.js'

// =============================================================================
// The install screen's render is pure: the installer used to be started from
// inside render (guarded by `installRunning`), a side effect React is free to
// repeat or throw away. It now starts from useInstallKickoff's effect; the
// "exactly once" render test lives in setup-wizard-steps-render.
// =============================================================================

describe('renderInstallStep', () => {
  it('neither updates state nor starts the installer while rendering', () => {
    const dispatch = vi.fn()
    const state = createInitialWizardState(freshState(), [])
    expect(state.installRunning).toBe(false)
    const ctx = {
      services: {},
      advance: vi.fn(),
      initialRegistered: [],
      failureResolverRef: { current: null },
      state,
      set: buildWizardSetters(dispatch, Object.keys(state) as (keyof WizardState)[]),
    } as unknown as WizardContext

    renderInstallStep(ctx)

    expect(dispatch).not.toHaveBeenCalled()
    expect(runInstallStep).not.toHaveBeenCalled()
  })
})
