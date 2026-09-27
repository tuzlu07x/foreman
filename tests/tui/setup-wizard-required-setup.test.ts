import { describe, expect, it } from 'vitest'
import { canSkipRequiredSecret } from '../../src/tui/setup-wizard/required-setup.js'

// =============================================================================
// Required-setup step rules.
// =============================================================================

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
