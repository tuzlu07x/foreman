import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #280 — Providers and Services pages must handle key.return
// to expand the selected row. Every other list page (logs / policy / sessions
// / secrets / agents) does this; these two were missing it, breaking the
// muscle-memory consistency the help overlay implies.
//
// We pin this at the source level (similar to the #219 wizard remount test)
// because driving ink + dashboard-context dependencies for a render test is
// heavy. A future refactor that strips key.return will trip CI here.
// =============================================================================

const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
)

function loadPage(name: string): string {
  return readFileSync(
    `${PROJECT_ROOT}/src/tui/pages/${name}-page.tsx`,
    'utf-8',
  )
}

describe('providers / services pages handle Enter (#280)', () => {
  it('providers page wires key.return to toggle row expansion', () => {
    const src = loadPage('providers')
    expect(src).toMatch(/if \(key\.return\)/)
    expect(src).toMatch(/setExpanded\(\(prev\) => !prev\)/)
  })

  it('services page wires key.return to toggle row expansion', () => {
    const src = loadPage('services')
    expect(src).toMatch(/if \(key\.return\)/)
    expect(src).toMatch(/setExpanded\(\(prev\) => !prev\)/)
  })

  it('providers row supports an `expanded` prop', () => {
    const src = loadPage('providers')
    expect(src).toMatch(/expanded: boolean/)
  })

  it('services row supports an `expanded` prop', () => {
    const src = loadPage('services')
    expect(src).toMatch(/expanded: boolean/)
  })

  it('arrow navigation resets the expanded flag on both pages', () => {
    // Otherwise scrolling through rows would carry the "expanded" overlay
    // onto whatever row happens to be selected — weird UX.
    const providers = loadPage('providers')
    const services = loadPage('services')
    for (const src of [providers, services]) {
      const hasUpReset = /key\.upArrow[\s\S]{0,200}setExpanded\(false\)/.test(
        src,
      )
      const hasDownReset = /key\.downArrow[\s\S]{0,200}setExpanded\(false\)/.test(
        src,
      )
      expect(hasUpReset, 'upArrow should reset expanded').toBe(true)
      expect(hasDownReset, 'downArrow should reset expanded').toBe(true)
    }
  })
})
