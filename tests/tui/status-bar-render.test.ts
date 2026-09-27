import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { StatusBar } from '../../src/tui/components/status-bar.js'

// =============================================================================
// Key-hint bar (#611): shows what the keys do on the current page. Page
// switching lives in the tab row, so the bar no longer lists every page.
// =============================================================================

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function frame(node: React.ReactElement): string {
  const { lastFrame } = render(node)
  return stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ').trim()
}

describe('StatusBar', () => {
  it('points at the command bar and inbox from the dashboard', () => {
    const out = frame(React.createElement(StatusBar, { page: 'dashboard' }))
    expect(out).toContain(': command')
    expect(out).toContain('n inbox')
    expect(out).toContain('? help')
    expect(out).toContain('q quit')
  })

  it('shows page-specific keys on the logs page', () => {
    const out = frame(React.createElement(StatusBar, { page: 'logs' }))
    expect(out).toContain('/ search')
    expect(out).toContain('r replay')
    expect(out).toContain('Esc home')
  })

  it('asks before quitting, and says what quitting means', () => {
    const out = frame(React.createElement(StatusBar, { page: 'dashboard', quitConfirm: true }))
    expect(out).toContain('Quit Foreman?')
    expect(out).toContain('y yes')
    expect(out).toContain('n no')
  })
})
