import { describe, expect, it } from 'vitest'
import { hasHiddenCharacters, jsonForTerminal, terminalSafe } from '../../src/core/terminal-text.js'

// #656 (H2). Hidden characters are built with fromCodePoint so this file
// holds none itself.
const ESC = String.fromCodePoint(0x1b)
const BEL = String.fromCodePoint(0x07)
const CSI8 = String.fromCodePoint(0x9b)
const RLO = String.fromCodePoint(0x202e)
const ZWSP = String.fromCodePoint(0x200b)
const LSEP = String.fromCodePoint(0x2028)
const TAG_A = String.fromCodePoint(0xe0041)
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/u

describe('terminalSafe', () => {
  it('shows the QA path attack instead of running it', () => {
    const path = `x${ESC}[2K\rdocs/README.md${ESC}[8m/.env`
    const shown = terminalSafe(path)
    expect(shown).toBe('x␛[2K␍docs/README.md␛[8m/.env')
    expect(shown).not.toMatch(HIDDEN)
  })

  it('makes OSC, C1, bidi, zero-width, separators and tag characters visible', () => {
    const id = `evil${ESC}]0;PWNED${BEL}${ESC}[2Jx`
    expect(terminalSafe(id)).toBe('evil␛]0;PWNED␇␛[2Jx')
    expect(terminalSafe(`a${CSI8}31m`)).toBe('a\\x9b31m')
    expect(terminalSafe(`${RLO}vne.${ZWSP}${LSEP}${TAG_A}`)).toBe('⟨U+202E⟩vne.⟨U+200B⟩⟨U+2028⟩⟨U+E0041⟩')
    expect(terminalSafe(`del${String.fromCodePoint(0x7f)}`)).toBe('del␡')
  })

  it('keeps newlines and tabs only for multi-line text', () => {
    expect(terminalSafe('a\nb\tc')).toBe('a␊b␉c')
    expect(terminalSafe('a\nb\tc', { multiline: true })).toBe('a\nb\tc')
    expect(terminalSafe('a\r\nb', { multiline: true })).toBe('a␍\nb')
  })

  it('leaves ordinary text, unicode included, alone', () => {
    for (const text of ['src/auth.ts', 'hermes → claude-code', 'café ✓ 日本語 🚀']) {
      expect(terminalSafe(text)).toBe(text)
      expect(hasHiddenCharacters(text)).toBe(false)
    }
    expect(hasHiddenCharacters(`a${RLO}`)).toBe(true)
  })
})

describe('jsonForTerminal', () => {
  it('escapes what JSON.stringify leaves raw, and stays valid JSON', () => {
    const value = { id: `evil${ESC}[2J`, path: `${RLO}gnp.exe`, c1: `x${CSI8}y`, tag: `t${TAG_A}` }
    const out = jsonForTerminal(value, 2)
    expect(out).not.toMatch(HIDDEN)
    expect(out).not.toContain(TAG_A)
    expect(out).toContain('\\u202e')
    expect(JSON.parse(out)).toEqual(value)
    expect(out.split('\n').length).toBeGreaterThan(1)
  })
})
