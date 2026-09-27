import type { Key } from 'ink'
import { describe, expect, it } from 'vitest'
import { isModifiedLetter } from '../../src/tui/setup-wizard/quit.js'

// =============================================================================
// Ctrl/Meta + letter must never reach the wizard's single-letter hotkeys
// (Ctrl-C arrived as "c" and started the install from required-setup).
// Esc and arrows can carry `meta` in Ink but have an empty input.
// =============================================================================

function key(overrides: Partial<Key>): Key {
  return { ctrl: false, meta: false, escape: false, upArrow: false, ...overrides } as Key
}

describe('isModifiedLetter', () => {
  it('flags Ctrl+letter and Meta+letter', () => {
    expect(isModifiedLetter('c', key({ ctrl: true }))).toBe(true)
    expect(isModifiedLetter('s', key({ meta: true }))).toBe(true)
    expect(isModifiedLetter('Q', key({ ctrl: true }))).toBe(true)
  })

  it('leaves plain letters alone', () => {
    expect(isModifiedLetter('c', key({}))).toBe(false)
  })

  it('leaves Esc and arrows alone even when Ink marks them meta', () => {
    expect(isModifiedLetter('', key({ escape: true, meta: true }))).toBe(false)
    expect(isModifiedLetter('', key({ upArrow: true, meta: true }))).toBe(false)
  })
})
