import { describe, expect, it } from 'vitest'
import {
  APPROVAL_ID_DISPLAY_PREFIX,
  approvalIdMissHint,
  classifyApprovalIdInput,
  formatApprovalIdForDisplay,
  parseSubmittedApprovalId,
} from '../../src/core/approval-id.js'

// =============================================================================
// Display formatting
// =============================================================================

describe('formatApprovalIdForDisplay', () => {
  it('prefixes a bare ULID', () => {
    const out = formatApprovalIdForDisplay('01HZX1234567890ABCDEFGHJKM')
    expect(out).toBe('aprv_01HZX1234567890ABCDEFGHJKM')
    expect(out.startsWith(APPROVAL_ID_DISPLAY_PREFIX)).toBe(true)
  })

  it('is idempotent — already-prefixed ids pass through unchanged', () => {
    const already = 'aprv_01HZX1234567890ABCDEFGHJKM'
    expect(formatApprovalIdForDisplay(already)).toBe(already)
  })
})

// =============================================================================
// Parsing submitted ids
// =============================================================================

describe('parseSubmittedApprovalId', () => {
  it('strips the aprv_ prefix', () => {
    expect(parseSubmittedApprovalId('aprv_01HZX1234567890ABCDEFGHJKM')).toBe(
      '01HZX1234567890ABCDEFGHJKM',
    )
  })

  it('passes a bare ULID through (back-compat for users on old notifications)', () => {
    expect(parseSubmittedApprovalId('01HZX1234567890ABCDEFGHJKM')).toBe(
      '01HZX1234567890ABCDEFGHJKM',
    )
  })

  it('trims whitespace before stripping', () => {
    expect(parseSubmittedApprovalId('  aprv_ULIDULIDULIDULIDULID12  ')).toBe(
      'ULIDULIDULIDULIDULID12',
    )
  })

  it('case-insensitively matches the prefix (user-typed APRV_…)', () => {
    expect(parseSubmittedApprovalId('APRV_01HZX1234567890ABCDEFGHJKM')).toBe(
      '01HZX1234567890ABCDEFGHJKM',
    )
  })
})

// =============================================================================
// Classification — the headline #552-PR-5 feature
// =============================================================================

describe('classifyApprovalIdInput', () => {
  it('classifies a bare ULID as foreman_approval', () => {
    const r = classifyApprovalIdInput('01HZX1234567890ABCDEFGHJKM')
    expect(r.kind).toBe('foreman_approval')
    expect(r.stripped).toBe('01HZX1234567890ABCDEFGHJKM')
  })

  it('classifies a prefixed ULID as foreman_approval', () => {
    const r = classifyApprovalIdInput('aprv_01HZX1234567890ABCDEFGHJKM')
    expect(r.kind).toBe('foreman_approval')
    expect(r.stripped).toBe('01HZX1234567890ABCDEFGHJKM')
  })

  it('flags a UUID (codex thread / claude-code session id shape) as agent session', () => {
    // The actual codex session id from the #552 investigation.
    const r = classifyApprovalIdInput('019e5e5e-9ce6-7172-af2f-ff9cca12608a')
    expect(r.kind).toBe('looks_like_agent_session')
    expect(r.stripped).toBe('019e5e5e-9ce6-7172-af2f-ff9cca12608a')
  })

  it('returns unknown for arbitrary junk', () => {
    expect(classifyApprovalIdInput('hello-world').kind).toBe('unknown')
    expect(classifyApprovalIdInput('').kind).toBe('unknown')
    expect(classifyApprovalIdInput('01HZX').kind).toBe('unknown') // too short
  })

  it('still strips the aprv_ prefix even for unrecognised remainders', () => {
    const r = classifyApprovalIdInput('aprv_not-a-real-id')
    expect(r.kind).toBe('unknown')
    expect(r.stripped).toBe('not-a-real-id')
  })
})

describe('approvalIdMissHint', () => {
  it('points foreman_approval misses at the chat notification', () => {
    const r = approvalIdMissHint({
      kind: 'foreman_approval',
      stripped: '01HZX...',
    })
    expect(r).toMatch(/Foreman approval notification/)
  })

  it('points looks_like_agent_session misses at the format mismatch', () => {
    const r = approvalIdMissHint({
      kind: 'looks_like_agent_session',
      stripped: '019e5e5e-9ce6-7172-af2f-ff9cca12608a',
    })
    expect(r).toMatch(/agent session/i)
    expect(r).toMatch(/ULID/)
  })

  it('shows an example for unknown formats', () => {
    const r = approvalIdMissHint({ kind: 'unknown', stripped: 'junk' })
    expect(r).toMatch(/aprv_/)
    expect(r).toMatch(/ULID/)
  })
})
