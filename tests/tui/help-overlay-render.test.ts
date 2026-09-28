import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { HelpOverlay, helpLines } from '../../src/tui/components/help-overlay.js'

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

  it('renders Everywhere / Pages / Approval modal columns on the first row', () => {
    expect(out).toContain('Everywhere')
    expect(out).toContain('Pages')
    expect(out).toContain('Approval modal')
  })

  it('renders page-specific groups on the second row (Logs / Agents / Providers)', () => {
    expect(out).toContain('Logs page')
    expect(out).toContain('Agents page')
    expect(out).toContain('Providers / Services')
  })

  it('renders extra groups on the third row (Secrets / Settings / Mediator test)', () => {
    expect(out).toContain('Secrets page')
    expect(out).toContain('Settings page')
    expect(out).toContain('Mediator test console')
  })

  it('lists the modal hotkeys including the new [t]echnical toggle (#232)', () => {
    expect(out).toContain('a / d')
    expect(out).toContain('A / D')
    expect(out).toContain('inspect details')
    // "toggle technical detail" wraps across two columns; assert pieces.
    expect(out).toContain('toggle technical')
    expect(out).toContain('detail')
  })

  it('explains the second key (y) for high/critical allows and D', () => {
    // The label wraps inside its column here; the one-line form is
    // pinned in the 200-column test below.
    expect(out).toContain('then y')
    expect(out).toContain('confirm a / A on')
    expect(out).toContain('high/critical')
  })

  it('says q / Ctrl-C ask first while an approval is open', () => {
    expect(out).toContain('quit (asks first)')
  })

  it('shows the close hint at the bottom', () => {
    expect(out).toContain('press h / ? / Esc to close')
  })
})

// QA #657 L4 — at 80x24 the top half of the help was cut off and could
// not scroll; at 200 columns labels wrapped in fixed 32-column cells.
describe('HelpOverlay — fits the terminal', () => {
  const text = (line: Array<{ text: string }>): string => line.map((s) => s.text).join('')

  it('uses two columns at 80 and keeps every line inside the frame', () => {
    const lines = helpLines(80).map(text)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(74)
    expect(lines.some((l) => /then y\s+confirm a \/ A on/.test(l))).toBe(true)
    expect(lines.find((l) => l.includes('Everywhere'))).toContain('Pages')
    expect(lines.find((l) => l.includes('Everywhere'))).not.toContain('Approval modal')
  })

  it('uses wide columns at 200, so labels stay on one line', () => {
    const wide = helpLines(200).map(text)
    expect(wide.find((l) => l.includes('Everywhere'))).toContain('Approval modal')
    expect(wide.some((l) => /n\s+inbox \(notifications\)/.test(l))).toBe(true)
    expect(wide.some((l) => /o\s+login \(OAuth \/ interactive\)/.test(l))).toBe(true)
    expect(wide.some((l) => /then y\s+confirm a \/ A on high\/critical risk, and D$/.test(l))).toBe(true)
    expect(wide.length).toBeLessThan(helpLines(80).length)
  })

  it('scrolls when the terminal is too short', async () => {
    const app = render(React.createElement(HelpOverlay, { width: 80, height: 18 }))
    const first = stripAnsi(app.lastFrame() ?? '')
    expect(first.split('\n').length).toBeLessThanOrEqual(18)
    expect(first).toContain('Everywhere')
    expect(first).toMatch(/scroll \(1–12 of \d+\)/)
    expect(first).not.toContain('Secrets page')
    // Page down until a later section shows (the layout grows with pages).
    let later = first
    for (let i = 0; i < 10 && !later.includes('Secrets page'); i++) {
      app.stdin.write('\u001B[6~')
      await new Promise((r) => setTimeout(r, 30))
      later = stripAnsi(app.lastFrame() ?? '')
    }
    expect(later).toContain('Secrets page')
    expect(later).not.toContain('Everywhere')
    app.unmount()
  })
})
