import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { InboxItem } from '../../src/db/schema.js'
import { InboxPage, groupInbox } from '../../src/tui/pages/inbox-page.js'

// The same notice added again and again (a crash on every start) shows as
// one row with a count, not a screenful of copies.

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

const NOW = 10 * 3_600_000

function item(id: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    createdAt: NOW,
    level: 'critical',
    kind: 'agent',
    title: 'hermes crashed (exit 127)',
    body: 'hermes: command not found.',
    requestId: null,
    agentId: 'hermes',
    dedupeKey: `crash:hermes:${id}`,
    readAt: null,
    ...over,
  }
}

// Newest first, as InboxService.list returns them.
const ITEMS: InboxItem[] = [
  item('c4', { createdAt: NOW - 60_000 }),
  item('u1', { level: 'info', kind: 'update', agentId: null, title: 'Foreman 9.9.9 is available', body: '', createdAt: NOW - 120_000 }),
  item('c3', { createdAt: NOW - 3_600_000 }),
  item('c2', { createdAt: NOW - 7_200_000, readAt: NOW - 7_000_000 }),
  item('c1', { createdAt: NOW - 9_000_000 }),
  // Same title from another agent: a different notice.
  item('o1', { agentId: 'openclaw', createdAt: NOW - 9_500_000 }),
]

describe('groupInbox', () => {
  it('folds identical notices into one group at the newest one, keeping the count', () => {
    const groups = groupInbox(ITEMS)
    expect(groups.map((g) => [g.latest.id, g.items.length, g.unread])).toEqual([
      ['c4', 4, 3],
      ['u1', 1, 1],
      ['o1', 1, 1],
    ])
  })

  it('keeps notices with different details apart', () => {
    const groups = groupInbox([item('a'), item('b', { body: 'something else' })])
    expect(groups).toHaveLength(2)
  })
})

describe('InboxPage grouping', () => {
  it('shows one row with ×N and the newest time', () => {
    const { lastFrame, unmount } = render(
      React.createElement(InboxPage, {
        items: ITEMS,
        unread: 5,
        onMarkRead: () => {},
        onMarkAllRead: () => {},
        active: false,
        height: 20,
        now: NOW,
      }),
    )
    const frame = strip(lastFrame())
    // hermes' four copies, and the one about the other agent.
    const rows = frame.split('\n').filter((l) => l.includes('hermes crashed'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('hermes crashed (exit 127) ×4')
    expect(rows[0]).toContain('1m ago')
    expect(rows[1]).not.toContain('×')
    expect(frame).toContain('showing all · 3')
    unmount()
  })

  it('marks every unread item in the group read', async () => {
    const read: string[] = []
    const { stdin, unmount } = render(
      React.createElement(InboxPage, {
        items: ITEMS,
        unread: 5,
        onMarkRead: (id: string) => read.push(id),
        onMarkAllRead: () => {},
        active: true,
        height: 20,
        now: NOW,
      }),
    )
    await tick()
    stdin.write('r')
    await tick()
    expect(read).toEqual(['c4', 'c3', 'c1'])
    unmount()
  })
})
