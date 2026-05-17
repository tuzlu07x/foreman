import { describe, expect, it, vi } from 'vitest'
import type { LlmClient, LlmResponse } from '../../../src/core/llm/client.js'
import {
  buildSummaryPrompt,
  detectLocaleFromEnv,
  narrateSummary,
  type SummaryLocale,
} from '../../../src/core/llm/summary-narrator.js'
import type { SummaryStats } from '../../../src/core/notification/summary-generator.js'

// =============================================================================
// Tests for #306 — smart summary narrator
// =============================================================================
//
// Pins:
//   - prompt assembly (each input field surfaces in the output text)
//   - locale switch (English ↔ Turkish system prompts)
//   - narrate happy path (LLM returns narrative → status: ok)
//   - empty stats → skipped (no LLM call)
//   - LLM throws → failed (caller falls back to template)
//   - empty model response → failed
//   - detectLocaleFromEnv defaults English, switches on tr*

function stats(overrides: Partial<SummaryStats> = {}): SummaryStats {
  return {
    totalCalls: 12,
    highRiskCalls: 1,
    agentsActive: ['hermes', 'openclaw'],
    decisionsAllowed: 10,
    decisionsDenied: 2,
    notificationsSent: 3,
    ...overrides,
  }
}

function fakeClient(
  response: Partial<LlmResponse> = { text: 'narrative body' },
): LlmClient {
  const merged: LlmResponse = {
    text: 'narrative body',
    inputTokens: 100,
    outputTokens: 150,
    costUsd: 0.001,
    durationMs: 250,
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

describe('buildSummaryPrompt', () => {
  it('includes the window label + stats in the prompt body', () => {
    const prompt = buildSummaryPrompt({
      stats: stats(),
      windowLabel: '12 hours',
    })
    expect(prompt).toContain('Window: 12 hours')
    expect(prompt).toContain('Total tool calls: 12')
    expect(prompt).toContain('Allowed: 10')
    expect(prompt).toContain('Denied: 2')
    expect(prompt).toContain('High/critical risk: 1')
  })

  it('renders agents with their responsibility note when supplied', () => {
    const prompt = buildSummaryPrompt({
      stats: stats(),
      windowLabel: '12 hours',
      responsibilities: {
        hermes: 'code writing',
        openclaw: 'project management',
      },
    })
    expect(prompt).toContain('- hermes (code writing)')
    expect(prompt).toContain('- openclaw (project management)')
  })

  it('omits responsibility parentheses when none is set for that agent', () => {
    const prompt = buildSummaryPrompt({
      stats: stats({ agentsActive: ['mystery'] }),
      windowLabel: '12 hours',
      responsibilities: {},
    })
    expect(prompt).toContain('  - mystery')
    expect(prompt).not.toContain('(undefined)')
  })

  it('includes factor counts sorted by frequency', () => {
    const prompt = buildSummaryPrompt({
      stats: stats(),
      windowLabel: '12 hours',
      factorCounts: { secret_pattern: 4, responsibility_violation: 2 },
    })
    const secretIdx = prompt.indexOf('secret_pattern: 4')
    const respIdx = prompt.indexOf('responsibility_violation: 2')
    expect(secretIdx).toBeGreaterThan(0)
    expect(respIdx).toBeGreaterThan(secretIdx)
  })

  it('includes budget line only when supplied', () => {
    const withBudget = buildSummaryPrompt({
      stats: stats(),
      windowLabel: '12 hours',
      budget: { spentUsd: 4.5, capUsd: 5, alertTripped: true },
    })
    expect(withBudget).toMatch(/Budget:.*\$4\.50.*\/.*\$5\.00.*alert tripped/)

    const without = buildSummaryPrompt({
      stats: stats(),
      windowLabel: '12 hours',
    })
    expect(without).not.toContain('Budget:')
  })

  it('emits an English system prompt by default', () => {
    const prompt = buildSummaryPrompt({
      stats: stats(),
      windowLabel: '12 hours',
    })
    expect(prompt).toMatch(/You are Foreman/i)
    expect(prompt).toMatch(/4 short paragraphs/i)
  })

  it.each<[SummaryLocale, RegExp]>([
    ['en', /You are Foreman/i],
    ['tr', /Sen Foreman/i],
  ])('locale=%s emits the right language system prompt', (locale, expected) => {
    const prompt = buildSummaryPrompt({
      stats: stats(),
      windowLabel: '12 hours',
      locale,
    })
    expect(prompt).toMatch(expected)
  })
})

describe('narrateSummary', () => {
  it('happy path: LLM returns narrative → status:ok with cost + duration', async () => {
    const client = fakeClient({ text: 'A clear summary paragraph.' })
    const result = await narrateSummary({
      client,
      stats: stats(),
      windowLabel: '12 hours',
    })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.text).toBe('A clear summary paragraph.')
      expect(result.costUsd).toBeGreaterThan(0)
      expect(result.durationMs).toBeGreaterThan(0)
    }
  })

  it('empty stats → skipped, no LLM call', async () => {
    const client = fakeClient()
    const result = await narrateSummary({
      client,
      stats: stats({
        totalCalls: 0,
        agentsActive: [],
        decisionsAllowed: 0,
        decisionsDenied: 0,
      }),
      windowLabel: '12 hours',
    })
    expect(result.status).toBe('skipped')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('LLM throws → status:failed (caller falls back to template)', async () => {
    const client: LlmClient = {
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
        throw new Error('network down')
      },
    }
    const result = await narrateSummary({
      client,
      stats: stats(),
      windowLabel: '12 hours',
    })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.reason).toContain('network down')
    }
  })

  it('empty model response → status:failed', async () => {
    const client = fakeClient({ text: '   \n  ' })
    const result = await narrateSummary({
      client,
      stats: stats(),
      windowLabel: '12 hours',
    })
    expect(result.status).toBe('failed')
  })

  it('passes through max-tokens override + temperature=0.3', async () => {
    const client = fakeClient({ text: 'ok' })
    await narrateSummary({
      client,
      stats: stats(),
      windowLabel: '12 hours',
      maxTokens: 1234,
    })
    const callMock = client.call as ReturnType<typeof vi.fn>
    expect(callMock).toHaveBeenCalledTimes(1)
    const opts = callMock.mock.calls[0]![1] as {
      maxTokens: number
      temperature: number
      feature: string
    }
    expect(opts.maxTokens).toBe(1234)
    expect(opts.temperature).toBe(0.3)
    expect(opts.feature).toBe('summary')
  })
})

describe('detectLocaleFromEnv', () => {
  it('returns en by default', () => {
    expect(detectLocaleFromEnv({})).toBe('en')
  })

  it.each(['tr', 'tr_TR', 'tr_TR.UTF-8', 'TR_TR.utf8'])(
    'returns tr for LANG=%s',
    (lang) => {
      expect(detectLocaleFromEnv({ LANG: lang })).toBe('tr')
    },
  )

  it('LC_ALL takes precedence when LANG is missing', () => {
    expect(detectLocaleFromEnv({ LC_ALL: 'tr_TR.UTF-8' })).toBe('tr')
  })

  it('unknown locale falls back to en', () => {
    expect(detectLocaleFromEnv({ LANG: 'de_DE.UTF-8' })).toBe('en')
  })
})
