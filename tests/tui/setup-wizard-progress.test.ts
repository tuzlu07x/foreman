import { describe, expect, it } from 'vitest'
import { STEPS } from '../../src/tui/setup-state.js'
import { stepProgress, type ProgressStep } from '../../src/tui/setup-wizard/progress.js'
import { WELCOME_STEPS } from '../../src/tui/setup-wizard/welcome.js'

// =============================================================================
// Every wizard screen's progress bar comes from the Welcome preview, so the
// numbering can't drift again ("Step 2 of 4 ▸ Agents" next to
// "Step 2 of 5 ▸ Foreman's brain").
// =============================================================================

const screens = STEPS.filter((s): s is ProgressStep => s !== 'welcome' && s !== 'done')

describe('stepProgress', () => {
  it('uses the Welcome preview total on every screen', () => {
    for (const step of screens) {
      expect(stepProgress(step).total).toBe(WELCOME_STEPS.length)
    }
  })

  it('numbers the steps the way the Welcome preview lists them', () => {
    expect(Object.fromEntries(screens.map((s) => [s, stepProgress(s).current]))).toEqual({
      providers: 1,
      'foreman-llm': 2,
      agents: 3,
      services: 4,
      integrations: 5,
      'chat-primary': 6,
      'required-setup': 6,
      install: 6,
    })
  })

  it('never goes backwards through the flow', () => {
    const numbers = screens.map((s) => stepProgress(s).current)
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers)
  })
})
