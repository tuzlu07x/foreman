import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { HelpOverlay } from '../../src/tui/components/help-overlay.js'

// =============================================================================
// Help overlay 3-column grid (#234 UX-7)
// =============================================================================

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function frame(): string {
  const { lastFrame } = render(React.createElement(HelpOverlay, {}))
  // ink columns wrap individual labels across lines on narrow terminals;
  // collapse whitespace so multi-line phrases still match as substrings.
  return stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ')
}

describe('HelpOverlay — new 3-column grid layout', () => {
  const out = frame()

  it('renders the Foreman Help title', () => {
    expect(out).toContain('Foreman Help')
  })

  it('renders Navigation / Pages / Approval modal columns on the first row', () => {
    expect(out).toContain('Navigation')
    expect(out).toContain('Pages')
    expect(out).toContain('Approval modal')
  })

  it('renders page-specific groups on the second row (Logs / Agents / Providers)', () => {
    expect(out).toContain('Logs page')
    expect(out).toContain('Agents page')
    expect(out).toContain('Providers / Services')
  })

  it('renders extra groups on the third row (Secrets / Settings / Chat)', () => {
    expect(out).toContain('Secrets page')
    expect(out).toContain('Settings page')
    expect(out).toContain('Chat / test console')
  })

  it('lists the modal hotkeys including the new [t]echnical toggle (#232)', () => {
    expect(out).toContain('a / d')
    expect(out).toContain('A / D')
    expect(out).toContain('inspect details')
    // "toggle technical detail" wraps across two columns; assert pieces.
    expect(out).toContain('toggle technical')
    expect(out).toContain('detail')
  })

  it('shows the close hint at the bottom', () => {
    expect(out).toContain('press h / ? / Esc to close')
  })
})
