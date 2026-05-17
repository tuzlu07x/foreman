import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultNotifyState,
  isAgentMuted,
  isSilenced,
  loadNotifyState,
  parseDuration,
  saveNotifyState,
} from '../../../src/core/notification/notify-state.js'

describe('notify-state — defaults + persistence', () => {
  let tmpDir: string
  let path: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'notify-state-'))
    path = join(tmpDir, 'notify-state.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('defaults to silencedUntil=null + empty mutedAgents', () => {
    const s = defaultNotifyState()
    expect(s.silencedUntil).toBeNull()
    expect(s.mutedAgents).toEqual([])
  })

  it('load returns defaults when file is absent', () => {
    const s = loadNotifyState(path)
    expect(s).toEqual(defaultNotifyState())
  })

  it('load returns defaults on empty file', () => {
    writeFileSync(path, '', 'utf-8')
    expect(loadNotifyState(path)).toEqual(defaultNotifyState())
  })

  it('load returns defaults on malformed JSON (no crash)', () => {
    writeFileSync(path, '{ not valid json', 'utf-8')
    expect(loadNotifyState(path)).toEqual(defaultNotifyState())
  })

  it('load returns defaults on schema-incompatible content', () => {
    writeFileSync(path, '{ "silencedUntil": "not a number" }', 'utf-8')
    expect(loadNotifyState(path)).toEqual(defaultNotifyState())
  })

  it('round-trips save → load', () => {
    const state = {
      silencedUntil: 1_700_000_000_000,
      mutedAgents: ['hermes', 'openclaw'],
    }
    saveNotifyState(path, state)
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('silencedUntil')
    expect(text).toContain('hermes')
    expect(loadNotifyState(path)).toEqual(state)
  })
})

describe('isSilenced', () => {
  it('false when silencedUntil is null', () => {
    expect(isSilenced({ silencedUntil: null, mutedAgents: [] })).toBe(false)
  })

  it('false when silencedUntil is in the past', () => {
    const past = Date.now() - 60_000
    expect(
      isSilenced({ silencedUntil: past, mutedAgents: [] }, Date.now()),
    ).toBe(false)
  })

  it('true when silencedUntil is in the future', () => {
    const future = Date.now() + 60_000
    expect(
      isSilenced({ silencedUntil: future, mutedAgents: [] }, Date.now()),
    ).toBe(true)
  })

  it('respects the optional `now` arg for deterministic tests', () => {
    expect(
      isSilenced({ silencedUntil: 100, mutedAgents: [] }, 50),
    ).toBe(true)
    expect(
      isSilenced({ silencedUntil: 100, mutedAgents: [] }, 200),
    ).toBe(false)
  })
})

describe('isAgentMuted', () => {
  it.each([
    [['hermes'], 'hermes', true],
    [['hermes'], 'openclaw', false],
    [[], 'hermes', false],
    [['hermes', 'openclaw'], 'openclaw', true],
  ] as const)(
    'mutedAgents=%j sourceAgent=%s → %s',
    (mutedAgents, sourceAgent, expected) => {
      expect(
        isAgentMuted({ silencedUntil: null, mutedAgents: [...mutedAgents] }, sourceAgent),
      ).toBe(expected)
    },
  )
})

describe('parseDuration', () => {
  it.each([
    ['30m', 30 * 60_000],
    ['4h', 4 * 3_600_000],
    ['1d', 86_400_000],
    ['2d', 2 * 86_400_000],
    ['  4h  ', 4 * 3_600_000], // trim
    ['4H', 4 * 3_600_000], // case-insensitive
  ])('parses %s → %d ms', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it.each([
    'invalid',
    '4',
    '4x',
    '0h',
    '-5m',
    '',
    '3.5h',
    '1w', // weeks not supported
  ])('returns null for unparseable: %s', (input) => {
    expect(parseDuration(input)).toBeNull()
  })
})
