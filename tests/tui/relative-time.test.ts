import { describe, expect, it } from 'vitest'
import { relativeTime } from '../../src/tui/format.js'

// #234 UX-10 — activity feed needs "Nm ago" / "Nh ago" not absolute HH:MM:SS.

const NOW = 1_700_000_000_000

describe('relativeTime', () => {
  it('"just now" for the last 5 seconds', () => {
    expect(relativeTime(NOW - 1_000, NOW)).toBe('just now')
    expect(relativeTime(NOW - 4_999, NOW)).toBe('just now')
  })

  it('"Ns ago" between 5 seconds and 1 minute', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('30s ago')
    expect(relativeTime(NOW - 59_000, NOW)).toBe('59s ago')
  })

  it('"Nm ago" up to an hour', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago')
  })

  it('"Nh ago" up to a day', () => {
    expect(relativeTime(NOW - 3 * 3600_000, NOW)).toBe('3h ago')
    expect(relativeTime(NOW - 23 * 3600_000, NOW)).toBe('23h ago')
  })

  it('"Nd ago" up to ~a month', () => {
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
    expect(relativeTime(NOW - 25 * 86_400_000, NOW)).toBe('25d ago')
  })

  it('"Nmo ago" beyond 30 days', () => {
    expect(relativeTime(NOW - 90 * 86_400_000, NOW)).toBe('3mo ago')
  })

  it('"Ny ago" beyond 12 months', () => {
    expect(relativeTime(NOW - 730 * 86_400_000, NOW)).toBe('2y ago')
  })

  it('clamps future timestamps to "just now" rather than going negative', () => {
    expect(relativeTime(NOW + 5_000, NOW)).toBe('just now')
  })
})
