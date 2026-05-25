import { describe, expect, it } from 'vitest'
import { renderSyntheticUpdate } from '../../src/core/synthetic-update-renderer.js'

const CTX = {
  autoUpdateId: -1,
  ownerChatId: 12345,
  directive: 'focus on issue Y',
}

describe('renderSyntheticUpdate — whole-string token substitution', () => {
  it('substitutes {auto} with the autoUpdateId number', () => {
    expect(renderSyntheticUpdate({ update_id: '{auto}' }, CTX)).toEqual({
      update_id: -1,
    })
  })

  it('substitutes {ownerChatId} with the numeric chat id', () => {
    expect(
      renderSyntheticUpdate({ from: { id: '{ownerChatId}' } }, CTX),
    ).toEqual({ from: { id: 12345 } })
  })

  it('substitutes {directive} with the directive string', () => {
    expect(renderSyntheticUpdate({ text: '{directive}' }, CTX)).toEqual({
      text: 'focus on issue Y',
    })
  })

  it('handles the full Telegram-update example from the #445 issue body', () => {
    const template = {
      update_id: '{auto}',
      message: {
        from: { id: '{ownerChatId}', is_bot: false },
        chat: { id: '{ownerChatId}', type: 'private' },
        text: '{directive}',
      },
    }
    expect(renderSyntheticUpdate(template, CTX)).toEqual({
      update_id: -1,
      message: {
        from: { id: 12345, is_bot: false },
        chat: { id: 12345, type: 'private' },
        text: 'focus on issue Y',
      },
    })
  })
})

describe('renderSyntheticUpdate — non-token values', () => {
  it('passes numbers / booleans / null through unchanged', () => {
    expect(
      renderSyntheticUpdate(
        { n: 42, b: true, x: null, s: 'literal' },
        CTX,
      ),
    ).toEqual({ n: 42, b: true, x: null, s: 'literal' })
  })

  it('walks into arrays', () => {
    expect(
      renderSyntheticUpdate(['{directive}', { id: '{ownerChatId}' }], CTX),
    ).toEqual(['focus on issue Y', { id: 12345 }])
  })

  it('passes unknown tokens through unchanged (future placeholders)', () => {
    expect(
      renderSyntheticUpdate({ a: '{unknown}', b: '{somethingElse}' }, CTX),
    ).toEqual({ a: '{unknown}', b: '{somethingElse}' })
  })

  it('does NOT do partial-string interpolation (whole-string only)', () => {
    // "user said: {directive}" should pass through unchanged in v1.
    // Partial interpolation is a future PR.
    expect(
      renderSyntheticUpdate({ text: 'user said: {directive}' }, CTX),
    ).toEqual({ text: 'user said: {directive}' })
  })
})

describe('renderSyntheticUpdate — immutability', () => {
  it('does not mutate the input template', () => {
    const template = { update_id: '{auto}', nested: { id: '{ownerChatId}' } }
    const snapshot = JSON.stringify(template)
    renderSyntheticUpdate(template, CTX)
    expect(JSON.stringify(template)).toEqual(snapshot)
  })

  it('returns a fresh object per call', () => {
    const template = { update_id: '{auto}' }
    const a = renderSyntheticUpdate(template, CTX)
    const b = renderSyntheticUpdate(template, CTX)
    expect(a).not.toBe(b)
  })
})
