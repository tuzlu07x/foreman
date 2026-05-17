import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { StatusBar } from '../../src/tui/components/status-bar.js'

// =============================================================================
// Status bar render checks (#234 UX-4)
// =============================================================================
//
// Just the surface-level assertions — the responsive layout split is unit-
// tested directly in `tests/tui/status-bar-layout.test.ts`. This file
// exercises the actual ink render to catch regressions like the active-page
// label disappearing or hotkey letters showing without brackets.

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function frame(node: React.ReactElement): string {
  const { lastFrame } = render(node)
  return stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ').trim()
}

describe('StatusBar', () => {
  it('renders the active page name when page="agents"', () => {
    const out = frame(React.createElement(StatusBar, { page: 'agents' }))
    expect(out).toContain('Agents')
  })

  it('renders the active page name when page="logs"', () => {
    const out = frame(React.createElement(StatusBar, { page: 'logs' }))
    expect(out).toContain('Logs')
  })

  it('every page hotkey letter [a][v][V][k][l][p][s] appears in the bar', () => {
    const out = frame(React.createElement(StatusBar, { page: 'dashboard' }))
    for (const letter of ['a', 'v', 'V', 'k', 'l', 'p', 's', 'h', 'q']) {
      expect(out).toContain(`[${letter}]`)
    }
  })

  it('shows "Quit? [y/n]" when quitConfirm is true', () => {
    const out = frame(
      React.createElement(StatusBar, { page: 'dashboard', quitConfirm: true }),
    )
    expect(out).toContain('Quit?')
    expect(out).toContain('[y/n]')
  })
})
