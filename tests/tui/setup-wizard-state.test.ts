import { describe, expect, it, vi } from 'vitest'
import {
  buildWizardSetters,
  createInitialWizardState,
  setterName,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from '../../src/tui/setup-wizard/state.js'
import { freshState } from '../../src/tui/setup-state.js'

// =============================================================================
// #621 — the setup wizard's shared state reducer. It must behave exactly like
// the individual useState hooks it replaced: value or updater, and the same
// identical-value bail-out.
// =============================================================================

function initial(registered: string[] = []): WizardState {
  return createInitialWizardState(freshState(), registered)
}

describe('createInitialWizardState', () => {
  it('starts every phase at its first screen', () => {
    const s = initial()
    expect(s.providersPhase).toBe('picker')
    expect(s.agentsPhase).toBe('picker')
    expect(s.foremanLlmPhase).toBe('picker')
    expect(s.servicesPhase).toBe('picker')
    expect(s.requiredSetupPhase).toBe('picker')
    expect(s.donePhase).toBe('main')
    expect(s.installRunning).toBe(false)
  })

  it('pre-selects the default agents on a fresh home', () => {
    expect(initial().agentsSelected).toEqual(['hermes', 'claude-code'])
  })

  it('pre-selects the already-registered agents when there are some', () => {
    expect(initial(['codex']).agentsSelected).toEqual(['codex'])
  })

  it('carries the persisted setup state through untouched', () => {
    const setup = { ...freshState(), completed: ['welcome' as const] }
    expect(createInitialWizardState(setup, []).setup).toBe(setup)
  })
})

describe('wizardReducer', () => {
  it('sets a plain value', () => {
    const next = wizardReducer(initial(), {
      type: 'set',
      key: 'providerIdx',
      value: 3,
    })
    expect(next.providerIdx).toBe(3)
  })

  it('applies an updater to the latest value', () => {
    const s0 = initial()
    const add = (name: string): WizardAction => ({
      type: 'set',
      key: 'providersSaved',
      value: (prev) => [...prev, name],
    })
    const s2 = wizardReducer(wizardReducer(s0, add('a-key')), add('b-key'))
    expect(s2.providersSaved).toEqual(['a-key', 'b-key'])
  })

  it('leaves every other field untouched', () => {
    const s0 = initial()
    const s1 = wizardReducer(s0, { type: 'set', key: 'serviceIdx', value: 1 })
    for (const key of Object.keys(s0) as (keyof WizardState)[]) {
      if (key === 'serviceIdx') continue
      expect(s1[key]).toBe(s0[key])
    }
  })

  it('returns the same state object for an identical value (useState bail-out)', () => {
    const s0 = initial()
    expect(
      wizardReducer(s0, { type: 'set', key: 'donePhase', value: 'main' }),
    ).toBe(s0)
    expect(
      wizardReducer(s0, {
        type: 'set',
        key: 'agentConfigs',
        value: (prev) => prev,
      }),
    ).toBe(s0)
  })
})

describe('buildWizardSetters', () => {
  it('derives one setX per field', () => {
    expect(setterName('providersPhase')).toBe('setProvidersPhase')
    expect(setterName('setup')).toBe('setSetup')
  })

  it('dispatches a set action for the matching field', () => {
    const dispatch = vi.fn()
    const s0 = initial()
    const set = buildWizardSetters(
      dispatch,
      Object.keys(s0) as (keyof WizardState)[],
    )
    set.setProvidersPhase('summary')
    const updater = (n: number): number => n + 1
    set.setSpinnerFrame(updater)
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: 'set',
      key: 'providersPhase',
      value: 'summary',
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'set',
      key: 'spinnerFrame',
      value: updater,
    })
  })

  it('covers every WizardState field', () => {
    const s0 = initial()
    const set = buildWizardSetters(
      vi.fn(),
      Object.keys(s0) as (keyof WizardState)[],
    )
    for (const key of Object.keys(s0) as (keyof WizardState)[]) {
      expect(typeof (set as Record<string, unknown>)[setterName(key)]).toBe(
        'function',
      )
    }
  })
})
