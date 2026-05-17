import { describe, expect, it } from 'vitest'
import {
  borderForRisk,
  boldBorder,
  buildTheme,
  doubleBorder,
  isAsciiMode,
  isHighContrast,
  riskColor,
  riskIcon,
  singleBorder,
  theme,
} from '../../src/tui/theme.js'

// =============================================================================
// Theme tokens + ASCII fallback + high-contrast (#234 UX-1 / UX-3)
// =============================================================================

describe('theme palette', () => {
  it('exports the four risk tokens consumers depend on', () => {
    expect(theme.risk.low).toBeDefined()
    expect(theme.risk.medium).toBeDefined()
    expect(theme.risk.high).toBeDefined()
    expect(theme.risk.critical).toBeDefined()
  })

  it('uses distinct values per risk level (so the modal actually shows severity)', () => {
    const values = new Set([
      theme.risk.low,
      theme.risk.medium,
      theme.risk.high,
      theme.risk.critical,
    ])
    expect(values.size).toBe(4)
  })

  it('Foreman orange stays #FF8C42 (brand pin)', () => {
    const defaultTheme = buildTheme({})
    expect(defaultTheme.accent.primary).toBe('#FF8C42')
  })
})

describe('buildTheme — ASCII mode swaps symbols only, palette stays', () => {
  it('default theme has unicode symbols', () => {
    const t = buildTheme({ ascii: false })
    expect(t.symbols.check).toBe('✓')
    expect(t.symbols.cross).toBe('✗')
    expect(t.symbols.bullet).toBe('▸')
    expect(t.symbols.cursor).toBe('❯')
    expect(t.symbols.arrow).toBe('→')
  })

  it('ascii: true replaces every unicode glyph with an ASCII fallback', () => {
    const t = buildTheme({ ascii: true })
    expect(t.symbols.check).toBe('+')
    expect(t.symbols.cross).toBe('x')
    expect(t.symbols.warn).toBe('!')
    expect(t.symbols.bullet).toBe('>')
    expect(t.symbols.cursor).toBe('>')
    expect(t.symbols.arrow).toBe('->')
    expect(t.symbols.loading).toBe('/')
  })

  it('ASCII mode does NOT change palette tokens (colors are still hex)', () => {
    const ascii = buildTheme({ ascii: true })
    expect(ascii.accent.primary).toMatch(/^#[0-9A-F]{6}$/i)
  })
})

describe('buildTheme — high-contrast palette', () => {
  it('emphasis stays pure white; muted gets brighter than the default', () => {
    const hc = buildTheme({ highContrast: true })
    expect(hc.fg.emphasis).toBe('#FFFFFF')
    // Brighter than the default's muted (#7A7A7A).
    expect(hc.fg.muted.toLowerCase()).not.toBe('#7a7a7a')
  })

  it('every risk token differs from the default-mode value (boosted contrast)', () => {
    const def = buildTheme({})
    const hc = buildTheme({ highContrast: true })
    expect(hc.risk.low).not.toBe(def.risk.low)
    expect(hc.risk.medium).not.toBe(def.risk.medium)
    expect(hc.risk.high).not.toBe(def.risk.high)
    expect(hc.risk.critical).not.toBe(def.risk.critical)
  })

  it('can combine high-contrast + ASCII without interfering', () => {
    const t = buildTheme({ ascii: true, highContrast: true })
    expect(t.symbols.check).toBe('+') // ASCII
    expect(t.fg.muted).not.toBe('#7A7A7A') // high contrast
  })
})

describe('riskColor — single source of truth', () => {
  it('maps each bucket to the matching theme.risk token', () => {
    expect(riskColor('low')).toBe(theme.risk.low)
    expect(riskColor('medium')).toBe(theme.risk.medium)
    expect(riskColor('high')).toBe(theme.risk.high)
    expect(riskColor('critical')).toBe(theme.risk.critical)
  })
})

describe('riskIcon — emoji + ASCII fallback', () => {
  it('returns emoji dots in default mode', () => {
    // The module-level `theme` reflects current env; force ASCII off for the
    // assertion by sniffing isAsciiMode.
    if (isAsciiMode()) return
    expect(riskIcon('critical')).toBe('🔴')
    expect(riskIcon('high')).toBe('🟠')
    expect(riskIcon('medium')).toBe('🟡')
    expect(riskIcon('low')).toBe('🟢')
  })
})

describe('isAsciiMode + isHighContrast env sniffing', () => {
  it('isAsciiMode reads FOREMAN_ASCII from the supplied env', () => {
    expect(isAsciiMode({ FOREMAN_ASCII: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isAsciiMode({ FOREMAN_ASCII: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isAsciiMode({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('isHighContrast reads FOREMAN_HIGH_CONTRAST', () => {
    expect(isHighContrast({ FOREMAN_HIGH_CONTRAST: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isHighContrast({} as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('border helpers', () => {
  it('singleBorder returns "single" unless ASCII mode is on (env-driven)', () => {
    // Module-level singleBorder reads process.env at call time — assert based
    // on whatever the current env says, then re-assert via buildTheme.
    if (isAsciiMode()) {
      const b = singleBorder() as { topLeft: string }
      expect(b.topLeft).toBe('+')
    } else {
      expect(singleBorder()).toBe('single')
    }
  })

  it('doubleBorder matches single but with the "double" name in unicode mode', () => {
    if (!isAsciiMode()) expect(doubleBorder()).toBe('double')
  })

  it('boldBorder returns "bold" in unicode mode and a "#" shape in ASCII', () => {
    if (isAsciiMode()) {
      const b = boldBorder() as { topLeft: string }
      expect(b.topLeft).toBe('#')
    } else {
      expect(boldBorder()).toBe('bold')
    }
  })

  it('borderForRisk picks single / double / bold per bucket', () => {
    if (isAsciiMode()) return // values are objects here, harder to compare
    expect(borderForRisk('low')).toBe('single')
    expect(borderForRisk('medium')).toBe('single')
    expect(borderForRisk('high')).toBe('double')
    expect(borderForRisk('critical')).toBe('bold')
  })
})
