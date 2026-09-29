import { describe, expect, it } from 'vitest'
import {
  aggregateStats,
  formatDuration,
  formatTime,
  percentBar,
  percentLabel,
  shortenPath,
  startOfTodayMs,
  statusIconFor,
  summariseTool,
  targetLabel,
} from '../../src/tui/format.js'

describe('formatTime', () => {
  it('pads HH:MM:SS', () => {
    const t = new Date('2026-05-13T09:14:23').getTime()
    expect(formatTime(t)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('formatDuration', () => {
  it.each([
    [null, ''],
    [0, '0ms'],
    [12, '12ms'],
    [999, '999ms'],
    [1000, '1.0s'],
    [1500, '1.5s'],
  ])('%s ms → "%s"', (ms, expected) => {
    expect(formatDuration(ms as number | null)).toBe(expected)
  })
})

describe('statusIconFor', () => {
  it.each([
    ['allowed', '✓', 'success'],
    ['denied', '✗', 'danger'],
    ['pending', '⚠', 'warning'],
  ] as const)('%s → %s / %s', (decision, icon, tone) => {
    const result = statusIconFor(decision)
    expect(result.icon).toBe(icon)
    expect(result.tone).toBe(tone)
  })
})

describe('summariseTool', () => {
  it('renders tool with quoted path arg', () => {
    expect(summariseTool('read_file', JSON.stringify({ path: '.env' }))).toBe(
      'read_file(".env")',
    )
  })
  it('renders tool with quoted text arg, truncated', () => {
    expect(
      summariseTool(
        'echo',
        JSON.stringify({ text: 'this is a very long string indeed yes' }),
      ),
    ).toMatch(/^echo\(".{0,33}…?"\)$/)
  })
  it('renders single-key fallback as key=value', () => {
    expect(summariseTool('do', JSON.stringify({ x: 42 }))).toBe('do(x=42)')
  })
  it('renders multi-key as "…N args"', () => {
    expect(
      summariseTool('mix', JSON.stringify({ a: 1, b: 2, c: 3 })),
    ).toBe('mix(…3 args)')
  })
  it('handles null tool', () => {
    expect(summariseTool(null, '{}')).toBe('(no tool)')
  })
  it('handles malformed args JSON', () => {
    expect(summariseTool('x', 'not-json')).toBe('x()')
  })
})

describe('targetLabel', () => {
  it('source only when no target agent', () => {
    expect(targetLabel('hermes', null)).toBe('hermes')
  })
  it('source → target when both set', () => {
    expect(targetLabel('hermes', 'claude-code')).toBe('hermes → claude-code')
  })
})

describe('aggregateStats', () => {
  it('counts decisions correctly', () => {
    const result = aggregateStats([
      { decision: 'allowed' },
      { decision: 'allowed' },
      { decision: 'denied' },
      { decision: 'pending' },
    ])
    expect(result).toEqual({ allowed: 2, denied: 1, pending: 1, total: 4 })
  })
  it('empty input → zeros', () => {
    expect(aggregateStats([])).toEqual({
      allowed: 0,
      denied: 0,
      pending: 0,
      total: 0,
    })
  })
})

describe('percentBar', () => {
  it('renders all dots when total is 0', () => {
    expect(percentBar(0, 0, 10)).toBe('··········')
  })
  it('renders full bar when value === total', () => {
    expect(percentBar(10, 10, 10)).toBe('██████████')
  })
  it('renders proportional', () => {
    const bar = percentBar(3, 10, 10)
    expect(bar).toHaveLength(10)
    expect(bar.split('█').length - 1).toBe(3)
  })
})

describe('percentLabel', () => {
  it.each([
    [0, 10, '0%'],
    [5, 10, '50%'],
    [10, 10, '100%'],
    [0, 0, '0%'],
  ])('%i of %i → "%s"', (v, t, expected) => {
    expect(percentLabel(v, t)).toBe(expected)
  })
})

describe('startOfTodayMs', () => {
  it('returns midnight local time of the given instant', () => {
    const now = new Date('2026-05-13T14:30:00').getTime()
    const start = startOfTodayMs(now)
    const d = new Date(start)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(d.getDate()).toBe(new Date(now).getDate())
  })
})

describe('shortenPath', () => {
  const home = '/Users/me'
  const long = '/Users/me/Projects/clients/acme/tuitour/.env'

  it('replaces the home directory with ~', () => {
    expect(shortenPath('/Users/me/src/app.ts', 80, home)).toBe('~/src/app.ts')
    expect(shortenPath('/Users/me', 80, home)).toBe('~')
    expect(shortenPath('/Users/me/src/app.ts', 80, '/Users/me/')).toBe('~/src/app.ts')
    // Only a whole folder name counts as the home directory.
    expect(shortenPath('/Users/meg/app.ts', 80, home)).toBe('/Users/meg/app.ts')
  })

  it('leaves a path that fits alone', () => {
    expect(shortenPath('/etc/hosts', 80, home)).toBe('/etc/hosts')
    expect(shortenPath('.env', 4, home)).toBe('.env')
  })

  it('gives up the middle folders first, keeping the file name', () => {
    expect(shortenPath(long, 30, home)).toBe('~/…/clients/acme/tuitour/.env')
    expect(shortenPath(long, 20, home)).toBe('~/…/tuitour/.env')
    expect(shortenPath('/var/lib/some/deep/folder/file.txt', 20, home)).toBe('/…/folder/file.txt')
  })

  it('never exceeds the width', () => {
    for (let w = 1; w <= long.length + 2; w++) {
      expect(shortenPath(long, w, home).length).toBeLessThanOrEqual(w)
    }
  })

  it('keeps the end of the file name on very short widths', () => {
    expect(shortenPath(long, 8, home)).toBe('~/…/.env')
    expect(shortenPath(long, 7, home)).toBe('…/.env')
    expect(shortenPath('/Users/me/a/very-long-file-name.txt', 8, home)).toBe('…ame.txt')
    expect(shortenPath(long, 1, home)).toBe('…')
    expect(shortenPath(long, 0, home)).toBe('…')
  })

  it('returns nothing for no path', () => {
    expect(shortenPath('', 20, home)).toBe('')
  })
})

describe('summariseTool with a width', () => {
  const args = JSON.stringify({ path: '/srv/data/clients/acme/tuitour/.env' })

  it('shortens a path argument in the middle to fit', () => {
    expect(summariseTool('read_file', args, 30)).toBe('read_file("/…/tuitour/.env")')
  })
  it('cuts other arguments at the end', () => {
    const many = JSON.stringify({ a: 1, b: 2, c: 3 })
    expect(summariseTool('a_very_long_tool_name', many, 12)).toBe('a_very_long…')
  })
  it('is unchanged without a width', () => {
    expect(summariseTool('read_file', args)).toBe('read_file("/srv/data/clients/acme/tuitour/.env")')
  })
})
