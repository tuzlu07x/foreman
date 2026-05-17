import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { requests } from '../../../src/db/schema.js'
import { generateSmartSummaryPayload } from '../../../src/core/notification/summary-generator.js'
import type { LlmClient, LlmResponse } from '../../../src/core/llm/client.js'

// =============================================================================
// Integration tests for #306 — generateSmartSummaryPayload
// =============================================================================
//
// Pins the wrapper's fallback behaviour: with an LLM client + activity, it
// returns the narrative body; without (or on LLM error / empty stats), it
// falls back to the template body unchanged.

function fakeClient(
  response: Partial<LlmResponse> = { text: 'narrative paragraph' },
): LlmClient {
  const merged: LlmResponse = {
    text: 'narrative paragraph',
    inputTokens: 50,
    outputTokens: 80,
    costUsd: 0.0001,
    durationMs: 100,
    cacheHit: false,
    ...response,
  }
  return {
    providerId: 'anthropic',
    model: 'claude-haiku-4-5',
    ping: async () => merged,
    call: vi.fn(async () => merged),
  }
}

function seedRequest(
  db: ForemanDb,
  overrides: Partial<typeof requests.$inferInsert>,
): void {
  db.insert(requests)
    .values({
      id: `r-${Math.random().toString(36).slice(2)}`,
      sourceAgent: 'hermes',
      args: '{}',
      riskScore: 0,
      decision: 'allowed',
      decidedBy: 'auto',
      createdAt: Date.now(),
      ...overrides,
    })
    .run()
}

describe('generateSmartSummaryPayload', () => {
  let db: ForemanDb
  let sqlite: Database.Database

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
  })
  afterEach(() => {
    sqlite.close()
  })

  it('returns the template body when no llmClient is supplied', async () => {
    seedRequest(db, {})
    const payload = await generateSmartSummaryPayload(db)
    expect(payload.body).toMatch(/Smart analysis is off/)
  })

  it('returns the LLM narrative when client is supplied + stats has data', async () => {
    seedRequest(db, {})
    seedRequest(db, {})
    const client = fakeClient({ text: 'rich contextual summary' })
    const payload = await generateSmartSummaryPayload(db, {
      llmClient: client,
    })
    expect(payload.body).toBe('rich contextual summary')
  })

  it('falls back to template body when stats is empty', async () => {
    // No rows seeded
    const client = fakeClient({ text: 'should not appear' })
    const payload = await generateSmartSummaryPayload(db, {
      llmClient: client,
    })
    expect(payload.body).toMatch(/No tool calls/)
    expect(client.call).not.toHaveBeenCalled()
  })

  it('falls back to template body when LLM throws', async () => {
    seedRequest(db, {})
    const throwing: LlmClient = {
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
      ping: async () => ({
        text: '',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 0,
        cacheHit: false,
      }),
      call: async () => {
        throw new Error('rate limit')
      },
    }
    const payload = await generateSmartSummaryPayload(db, {
      llmClient: throwing,
    })
    expect(payload.body).toMatch(/Smart analysis is off/)
  })

  it('preserves the template title (only body is replaced on smart path)', async () => {
    seedRequest(db, {})
    const client = fakeClient({ text: 'smart body' })
    const payload = await generateSmartSummaryPayload(db, {
      llmClient: client,
    })
    expect(payload.title).toMatch(/Foreman summary/)
  })

  it('passes responsibilities + factor counts into the prompt', async () => {
    seedRequest(db, {
      riskFactors: JSON.stringify([
        { rule: 'secret_pattern', category: 'secret', points: 50 },
      ]),
    })
    const client = fakeClient({ text: 'narrative' })
    await generateSmartSummaryPayload(db, {
      llmClient: client,
      responsibilities: { hermes: 'code writing' },
    })
    const callMock = client.call as ReturnType<typeof vi.fn>
    const prompt = callMock.mock.calls[0]![0] as string
    expect(prompt).toContain('hermes (code writing)')
    expect(prompt).toContain('secret_pattern: 1')
  })
})
