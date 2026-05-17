import { describe, expect, it } from 'vitest'
import { cleanEvidence } from '../../src/core/risk-rules/secret-patterns.js'

// Regression for #284 — JSON.stringify-derived evidence used to leak the
// surrounding double-quote into the modal ("↳ ".env").

describe('cleanEvidence', () => {
  it('strips a leading JSON double-quote', () => {
    expect(cleanEvidence('".env')).toBe('.env')
  })

  it('strips a trailing JSON double-quote', () => {
    expect(cleanEvidence('.env"')).toBe('.env')
  })

  it('strips both leading and trailing quotes', () => {
    expect(cleanEvidence('".env"')).toBe('.env')
  })

  it('strips single quotes too (CLI / TOML artefacts)', () => {
    expect(cleanEvidence("'/.aws/credentials'")).toBe('/.aws/credentials')
  })

  it('preserves internal quotes (not a paired wrapper)', () => {
    expect(cleanEvidence('foo"bar')).toBe('foo"bar')
  })

  it('leaves clean input untouched', () => {
    expect(cleanEvidence('id_rsa')).toBe('id_rsa')
    expect(cleanEvidence('')).toBe('')
  })
})
