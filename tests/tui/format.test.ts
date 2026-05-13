import { describe, expect, it } from 'vitest'
import {
  aggregateStats,
  formatDuration,
  formatTime,
  percentBar,
  percentLabel,
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
