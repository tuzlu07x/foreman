import { describe, expect, it } from 'vitest'
import { hintsFor } from '../../src/tui/components/status-bar.js'
import { TABS } from '../../src/tui/components/app-header.js'

describe('hintsFor (#611)', () => {
  it('always offers help and quit on the right', () => {
    for (const layout of ['wide', 'medium', 'narrow'] as const) {
      expect(hintsFor('dashboard', layout).right.map((h) => h.key)).toEqual(['?', 'q'])
    }
  })

  it('trims page hints on narrow terminals', () => {
    expect(hintsFor('agents', 'wide').left.length).toBeGreaterThan(3)
    expect(hintsFor('agents', 'narrow').left).toHaveLength(3)
  })

  it('has hints for every page reachable from the tab row', () => {
    for (const tab of TABS) {
      expect(hintsFor(tab.page, 'wide').left.length).toBeGreaterThan(0)
    }
  })
})
