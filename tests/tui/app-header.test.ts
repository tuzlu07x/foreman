import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { AppHeader, NavTabs, nextTab, TABS } from '../../src/tui/components/app-header.js'
import { consoleLines } from '../../src/tui/components/command-bar.js'

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')

describe('AppHeader (#611)', () => {
  const stats = { agentsOnline: 2, agentsTotal: 3, pendingApprovals: 1, unread: 4, allowedToday: 10, deniedToday: 2 }

  it('answers "is anything waiting on me?" at a glance', () => {
    const out = strip(render(React.createElement(AppHeader, { stats, width: 140 })).lastFrame())
    expect(out).toContain('FOREMAN')
    expect(out).toContain('2/3 agents')
    expect(out).toContain('1 waiting')
    expect(out).toContain('4 new')
    expect(out).toContain('10')
  })

  it('drops the secondary chips on narrow terminals', () => {
    const out = strip(render(React.createElement(AppHeader, { stats, width: 80 })).lastFrame())
    expect(out).toContain('1 waiting')
    expect(out).not.toContain('today')
  })
})

describe('NavTabs', () => {
  it('keeps the active tab visible even when it is far right', () => {
    const out = strip(render(React.createElement(NavTabs, { page: 'chat', unread: 0, width: 80 })).lastFrame())
    expect(out).toContain('▎Test')
    expect(out).toContain('‹')
  })

  it('shows the unread count on the Inbox tab', () => {
    const out = strip(render(React.createElement(NavTabs, { page: 'dashboard', unread: 7, width: 140 })).lastFrame())
    expect(out).toContain('Inbox 7')
  })

  it('Tab and Shift-Tab cycle through every page', () => {
    let page = TABS[0]!.page
    const seen = new Set<string>()
    for (let i = 0; i < TABS.length; i++) {
      seen.add(page)
      page = nextTab(page, 1)
    }
    expect(seen.size).toBe(TABS.length)
    expect(nextTab('dashboard', -1)).toBe(TABS[TABS.length - 1]!.page)
  })
})

describe('consoleLines', () => {
  it('echoes each command above its output and marks failures', () => {
    expect(
      consoleLines([
        { line: 'status', ok: true, output: ['2 agents'] },
        { line: 'write ghost x', ok: false, output: ['Unknown agent'] },
      ]),
    ).toEqual([
      { text: '› status', tone: 'cmd' },
      { text: '2 agents', tone: 'ok' },
      { text: '› write ghost x', tone: 'cmd' },
      { text: 'Unknown agent', tone: 'error' },
    ])
  })
})
