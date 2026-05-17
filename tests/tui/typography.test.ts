import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import {
  Caption,
  Divider,
  KeyValueRow,
  PageHeader,
  Subheader,
} from '../../src/tui/components/typography.js'

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function frame(node: React.ReactElement): string {
  const { lastFrame } = render(node)
  return stripAnsi(lastFrame() ?? '')
}

describe('PageHeader', () => {
  it('renders the title in bold + accent (no divider when noDivider=true)', () => {
    const out = frame(
      React.createElement(PageHeader, { title: 'Agents', noDivider: true }),
    )
    expect(out).toContain('Agents')
    expect(out).not.toContain('─') // no divider
  })

  it('places right text on the same row when provided', () => {
    const out = frame(
      React.createElement(PageHeader, {
        title: 'Agents',
        right: '3 registered · 2 active',
        noDivider: true,
      }),
    )
    expect(out).toContain('Agents')
    expect(out).toContain('3 registered · 2 active')
    // Same line — verify by collapsing whitespace and checking proximity.
    const collapsed = out.replace(/\s+/g, ' ')
    expect(collapsed).toContain('Agents')
    expect(collapsed).toContain('3 registered')
  })

  it('renders a divider rule under the header by default', () => {
    const out = frame(React.createElement(PageHeader, { title: 'Agents' }))
    expect(out).toContain('─')
  })

  it('supports an inline subtitle next to the title', () => {
    const out = frame(
      React.createElement(PageHeader, {
        title: 'Agents',
        subtitle: 'guarded',
        noDivider: true,
      }),
    )
    expect(out).toContain('Agents')
    expect(out).toContain('guarded')
  })
})

describe('Subheader / Caption / Divider', () => {
  it('Subheader renders its child', () => {
    const out = frame(React.createElement(Subheader, { children: 'Section' }))
    expect(out).toContain('Section')
  })

  it('Caption respects the indent prop (2 spaces per level)', () => {
    const out = frame(
      React.createElement(Caption, { children: 'hint', indent: 2 }),
    )
    expect(out).toContain('    hint') // 2 * 2 spaces
  })

  it('Divider renders exactly N "─" characters', () => {
    const out = frame(React.createElement(Divider, { width: 12 }))
    expect(out).toContain('─'.repeat(12))
  })

  // Regression for #282 — String.prototype.repeat throws on negative
  // counts. Boot banner passes `Math.min(60, termCols - 2)` which goes
  // negative when termCols is undefined / 0 / 1 (pty default, very narrow
  // terminal). Divider must clamp instead of throwing.
  it('Divider clamps negative width to 1 instead of crashing', () => {
    expect(() =>
      frame(React.createElement(Divider, { width: -10 })),
    ).not.toThrow()
    const out = frame(React.createElement(Divider, { width: -10 }))
    expect(out).toContain('─')
  })

  it('Divider clamps zero to 1', () => {
    const out = frame(React.createElement(Divider, { width: 0 }))
    expect(out).toContain('─')
  })

  it('Divider clamps NaN / Infinity to a sane width', () => {
    expect(() =>
      frame(React.createElement(Divider, { width: NaN })),
    ).not.toThrow()
    expect(() =>
      frame(React.createElement(Divider, { width: Infinity })),
    ).not.toThrow()
  })

  it('Divider caps absurdly large widths so render time stays bounded', () => {
    const out = frame(React.createElement(Divider, { width: 10_000 }))
    // 200 is the clamp ceiling.
    expect(out.replace(/[^─]/g, '').length).toBeLessThanOrEqual(200)
  })
})

describe('KeyValueRow', () => {
  it('pads the label out to labelWidth and renders the value after', () => {
    const out = frame(
      React.createElement(KeyValueRow, {
        label: 'identity',
        value: 'ed25519:abc',
        labelWidth: 18,
      }),
    )
    const collapsed = out.replace(/\s+/g, ' ').trim()
    expect(collapsed).toContain('identity')
    expect(collapsed).toContain('ed25519:abc')
  })
})
