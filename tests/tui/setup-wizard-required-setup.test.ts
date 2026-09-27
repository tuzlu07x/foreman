import { describe, expect, it } from 'vitest'
import {
  canSkipRequiredSecret,
  clampCursor,
} from '../../src/tui/setup-wizard/required-setup.js'

// =============================================================================
// Required-setup step rules.
// =============================================================================

describe('clampCursor', () => {
  it('stays at 0 on an empty list (Down used to set -1)', () => {
    expect(clampCursor(0 + 1, 0)).toBe(0)
    expect(clampCursor(-1, 0)).toBe(0)
  })

  it('pulls a cursor left past the end of a shrunken list back onto it', () => {
    expect(clampCursor(3, 1)).toBe(0)
    expect(clampCursor(5, 3)).toBe(2)
  })

  it('leaves an in-range cursor alone', () => {
    expect(clampCursor(1, 3)).toBe(1)
  })
})

describe('canSkipRequiredSecret', () => {
  it('only skips a secret nobody has provided', () => {
    expect(canSkipRequiredSecret('missing')).toBe(true)
  })

  it('never marks a stored or just-pasted secret as skipped', () => {
    expect(canSkipRequiredSecret('present')).toBe(false)
    expect(canSkipRequiredSecret('saved-in-session')).toBe(false)
    expect(canSkipRequiredSecret('skipped')).toBe(false)
  })
})
