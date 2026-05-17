import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { EmptyState } from '../../src/tui/components/empty-state.js'

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function frame(props: Parameters<typeof EmptyState>[0]): string {
  const { lastFrame } = render(React.createElement(EmptyState, props))
  return stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ')
}

describe('EmptyState (#234 UX-5)', () => {
  it('renders the title with a bullet prefix', () => {
    const out = frame({ title: 'No agents registered yet' })
    expect(out).toContain('No agents registered yet')
  })

  it('renders the body when supplied', () => {
    const out = frame({
      title: 'No sessions yet',
      body: 'A session is a chain of related tool calls.',
    })
    expect(out).toContain('No sessions yet')
    expect(out).toContain('chain of related tool calls')
  })

  it('renders each command on its own line with an arrow prefix', () => {
    const out = frame({
      title: 'X',
      commands: ['foreman setup', 'foreman agent add foo --type hermes'],
    })
    expect(out).toContain('Try:')
    expect(out).toContain('foreman setup')
    expect(out).toContain('foreman agent add foo --type hermes')
  })

  it('joins hotkey hints with separators', () => {
    const out = frame({
      title: 'X',
      hotkeys: ['[Esc] back', '[r] retry'],
    })
    expect(out).toContain('[Esc] back')
    expect(out).toContain('[r] retry')
    expect(out).toContain('·')
  })

  it('renders cleanly with only a title (no body / commands / hotkeys)', () => {
    const out = frame({ title: 'Just a title' })
    expect(out).toContain('Just a title')
    expect(out).not.toContain('Try:')
  })
})
