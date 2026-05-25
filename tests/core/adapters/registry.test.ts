import { describe, expect, it } from 'vitest'
import {
  getAdapter,
  listAdapterIds,
  codexExecServerV1Adapter,
  claudeCodePreToolUseV1Adapter,
} from '../../../src/core/adapters/index.js'

describe('adapter registry', () => {
  it('lists every registered adapter by id, alphabetically', () => {
    const ids = listAdapterIds()
    expect(ids).toContain('codex-exec-server-v1')
    expect(ids).toContain('claude-code-pretooluse-v1')
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })

  it('returns the codex adapter via getAdapter', () => {
    expect(getAdapter('codex-exec-server-v1')).toBe(codexExecServerV1Adapter)
  })

  it('returns the claude-code adapter via getAdapter', () => {
    expect(getAdapter('claude-code-pretooluse-v1')).toBe(claudeCodePreToolUseV1Adapter)
  })

  it('returns null for unknown adapter ids — callers decide between fail-closed deny and fallback', () => {
    expect(getAdapter('does-not-exist')).toBeNull()
  })

  it('every adapter exposes a non-empty id and label', () => {
    for (const id of listAdapterIds()) {
      const adapter = getAdapter(id)
      expect(adapter).not.toBeNull()
      expect(adapter!.id).toBe(id)
      expect(adapter!.id.length).toBeGreaterThan(0)
      expect(adapter!.label.length).toBeGreaterThan(0)
    }
  })
})
