import { describe, expect, it } from 'vitest'
import { layoutForCols } from '../../src/tui/layout.js'

describe('layoutForCols', () => {
  it.each([
    [200, 'wide'],
    [120, 'wide'],
    [119, 'medium'],
    [100, 'medium'],
    [80, 'medium'],
    [79, 'narrow'],
    [40, 'narrow'],
    [0, 'narrow'],
  ] as const)('cols=%i → %s', (cols, expected) => {
    expect(layoutForCols(cols)).toBe(expected)
  })
})
