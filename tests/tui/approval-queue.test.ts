import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import {
  EMPTY_QUEUE,
  EXPIRY_GRACE_MS,
  enqueueApproval,
  expireApprovals,
  moveSelection,
  removeApproval,
  selectedApproval,
  selectedIndex,
} from '../../src/tui/approval-queue.js'

const req = (requestId: string, deadlineMs?: number): ApprovalRequest => ({
  requestId,
  sourceAgent: 'agent',
  targetTool: 'tool',
  args: {},
  riskScore: 70,
  riskReasons: [],
  riskFactors: [],
  riskBucket: 'high',
  llmVerification: null,
  securityReport: null,
  ...(deadlineMs !== undefined ? { deadlineMs } : {}),
})

describe('approval queue (#614)', () => {
  it('keeps every pending approval, ordered by deadline, and dedupes', () => {
    let q = enqueueApproval(EMPTY_QUEUE, req('late', 9_000), 0)
    q = enqueueApproval(q, req('soon', 3_000), 0)
    q = enqueueApproval(q, req('soon', 3_000), 0)
    expect(q.items.map((i) => i.request.requestId)).toEqual(['soon', 'late'])
  })

  it('never steals focus when another approval arrives', () => {
    let q = enqueueApproval(EMPTY_QUEUE, req('first', 9_000), 0)
    q = enqueueApproval(q, req('urgent', 1_000), 0)
    expect(selectedApproval(q)!.request.requestId).toBe('first')
  })

  it('removing the one on screen shows the next in line, then the previous', () => {
    let q = EMPTY_QUEUE
    for (const [id, d] of [['a', 1], ['b', 2], ['c', 3]] as const) q = enqueueApproval(q, req(id, d * 1000), 0)
    q = moveSelection(q, 1) // b
    q = removeApproval(q, 'b')
    expect(selectedApproval(q)!.request.requestId).toBe('c')
    q = removeApproval(q, 'c')
    expect(selectedApproval(q)!.request.requestId).toBe('a')
    q = removeApproval(q, 'a')
    expect(q).toEqual(EMPTY_QUEUE)
  })

  it('removing a different item keeps the selection where it is', () => {
    let q = enqueueApproval(EMPTY_QUEUE, req('a', 1_000), 0)
    q = enqueueApproval(q, req('b', 2_000), 0)
    q = moveSelection(q, 1)
    q = removeApproval(q, 'a')
    expect(selectedApproval(q)!.request.requestId).toBe('b')
    expect(selectedIndex(q)).toBe(0)
  })

  it('wraps selection both ways', () => {
    let q = enqueueApproval(EMPTY_QUEUE, req('a', 1_000), 0)
    q = enqueueApproval(q, req('b', 2_000), 0)
    expect(selectedApproval(moveSelection(q, -1))!.request.requestId).toBe('b')
    expect(selectedApproval(moveSelection(q, 2))!.request.requestId).toBe('a')
  })

  it('hides items only after their deadline plus grace, without resolving them', () => {
    let q = enqueueApproval(EMPTY_QUEUE, req('a', 1_000), 0)
    q = enqueueApproval(q, req('b', 60_000), 0)
    expect(expireApprovals(q, 1_000 + EXPIRY_GRACE_MS).items).toHaveLength(2)
    q = expireApprovals(q, 1_001 + EXPIRY_GRACE_MS)
    expect(q.items.map((i) => i.request.requestId)).toEqual(['b'])
  })

  it('falls back to a display deadline when the request has none', () => {
    const q = enqueueApproval(EMPTY_QUEUE, req('a'), 5_000)
    expect(q.items[0]!.deadline).toBe(65_000)
  })
})
