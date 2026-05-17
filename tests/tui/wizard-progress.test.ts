import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import {
  WIZARD_STEPS,
  WizardProgress,
  stepNumber,
} from '../../src/tui/components/wizard-progress.js'

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function frame(node: React.ReactElement): string {
  const { lastFrame } = render(node)
  return stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ').trim()
}

describe('WizardProgress (#234 UX-9)', () => {
  it('renders a filled █ for the current step and ░ for the rest', () => {
    const out = frame(
      React.createElement(WizardProgress, {
        current: 2,
        total: 4,
        label: 'Agents',
      }),
    )
    expect(out).toContain('[██░░]')
  })

  it('shows "Step 2 of 4 ▸ Agents"', () => {
    const out = frame(
      React.createElement(WizardProgress, {
        current: 2,
        total: 4,
        label: 'Agents',
      }),
    )
    expect(out).toContain('Step 2 of 4')
    expect(out).toContain('Agents')
  })

  it('appends a phase tail when supplied', () => {
    const out = frame(
      React.createElement(WizardProgress, {
        current: 3,
        total: 4,
        label: 'Services',
        phase: 'summary',
      }),
    )
    expect(out).toContain('Services')
    expect(out).toContain('summary')
  })

  it('clamps when current > total (defensive)', () => {
    const out = frame(
      React.createElement(WizardProgress, {
        current: 99,
        total: 4,
        label: 'Done',
      }),
    )
    expect(out).toContain('[████]')
    expect(out).toContain('Step 4 of 4')
  })

  it('clamps when current < 0 (defensive)', () => {
    const out = frame(
      React.createElement(WizardProgress, {
        current: -1,
        total: 4,
        label: 'Reset',
      }),
    )
    expect(out).toContain('[░░░░]')
    expect(out).toContain('Step 0 of 4')
  })
})

describe('WIZARD_STEPS + stepNumber', () => {
  it('exports the four canonical wizard steps in order', () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual([
      'providers',
      'agents',
      'services',
      'install',
    ])
  })

  it('stepNumber returns 1-indexed positions', () => {
    expect(stepNumber('providers')).toBe(1)
    expect(stepNumber('agents')).toBe(2)
    expect(stepNumber('services')).toBe(3)
    expect(stepNumber('install')).toBe(4)
  })
})
