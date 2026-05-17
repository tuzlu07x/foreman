import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LlmBudgetExceededError,
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from '../../../src/core/llm/client.js'
import { recordUsage } from '../../../src/core/llm/budget.js'
import { defaultLlmConfig } from '../../../src/core/llm/config.js'
import { type PromptContext } from '../../../src/core/llm/prompts.js'
import { combineAssessment, LlmVerifier } from '../../../src/core/llm/verifier.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import type {
  LlmVerification,
  RiskAssessment,
  RiskFactor,
} from '../../../src/core/risk-rules/types.js'

class FakeLlmClient implements LlmClient {
  readonly providerId = 'anthropic' as const
  readonly model = 'claude-haiku-4-5'
  callCount = 0
  /** Override the next response. */
  nextText:
    | string
    | (() => string)
    | { throw: Error } = JSON.stringify({
    is_real_threat: true,
    threat_type: 'credential_theft',
    confidence: 0.9,
    explanation_short: 'Phishing chain + .env',
    explanation_long: 'Looks like a real credential-theft chain.',
    recommended_action: 'deny',
    additional_risk_score: 10,
    user_should_check: ['Sender of trigger email'],
  })

  async ping(): Promise<LlmResponse> {
    return this.call('ping', { feature: 'test', maxTokens: 8 })
  }

  async call(_prompt: string, _opts: LlmCallOptions): Promise<LlmResponse> {
    this.callCount += 1
    if (typeof this.nextText === 'object' && 'throw' in this.nextText) {
      throw this.nextText.throw
    }
    const text =
      typeof this.nextText === 'function' ? this.nextText() : this.nextText
    return {
      text,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      durationMs: 120,
      cacheHit: false,
    }
  }
}

function factor(overrides: Partial<RiskFactor> = {}): RiskFactor {
  return {
    rule: 'secret_path',
    category: 'secret',
    points: 60,
    reason: '.env-style file',
    ...overrides,
  }
}

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    sourceAgent: 'hermes',
    sourceResponsibility: null,
    targetAgent: 'claude-code',
    targetTool: 'read_file',
    args: { path: '.env' },
    factors: [factor()],
    totalScore: 80,
    bucket: 'high',
    recentCalls: [],
    externalTrigger: null,
    ...overrides,
  }
}

function configWithFeature(): ReturnType<typeof defaultLlmConfig> {
  const c = defaultLlmConfig()
  c.enabled = true
  c.features.verification = true
  return c
}

describe('LlmVerifier — gating', () => {
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

  it('skipped feature_disabled when global is off', async () => {
    const v = new LlmVerifier({
      db,
      config: defaultLlmConfig(), // OFF by default
      client: new FakeLlmClient(),
    })
    const out = await v.verify(makeCtx())
    expect(out.skipped).toBe('feature_disabled')
    expect(out.fromCache).toBe(false)
  })

  it('skipped feature_disabled when feature is off but global is on', async () => {
    const config = defaultLlmConfig()
    config.enabled = true
    // features.verification stays false
    const v = new LlmVerifier({ db, config, client: new FakeLlmClient() })
    const out = await v.verify(makeCtx())
    expect(out.skipped).toBe('feature_disabled')
  })

  it('skipped below_threshold when score < 30', async () => {
    const v = new LlmVerifier({
      db,
      config: configWithFeature(),
      client: new FakeLlmClient(),
    })
    const out = await v.verify(makeCtx({ totalScore: 10, bucket: 'low' }))
    expect(out.skipped).toBe('below_threshold')
  })

  it('skipped budget_exhausted when window cost ≥ cap', async () => {
    const config = configWithFeature()
    recordUsage(db, {
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: config.budget.monthly_cap_usd + 1, // over
      durationMs: 1,
    })
    const v = new LlmVerifier({
      db,
      config,
      client: new FakeLlmClient(),
    })
    const out = await v.verify(makeCtx())
    expect(out.skipped).toBe('budget_exhausted')
  })

  it('passes all gates → calls the client + parses', async () => {
    const client = new FakeLlmClient()
    const v = new LlmVerifier({ db, config: configWithFeature(), client })
    const out = await v.verify(makeCtx())
    expect(out.skipped).toBeUndefined()
    expect(out.is_real_threat).toBe(true)
    expect(out.recommended_action).toBe('deny')
    expect(out.provider).toBe('anthropic')
    expect(out.model).toBe('claude-haiku-4-5')
    expect(out.fromCache).toBe(false)
    expect(client.callCount).toBe(1)
  })
})

describe('LlmVerifier — cache', () => {
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

  it('second identical context hits the cache (no second client call)', async () => {
    const client = new FakeLlmClient()
    const v = new LlmVerifier({ db, config: configWithFeature(), client })
    const out1 = await v.verify(makeCtx())
    const out2 = await v.verify(makeCtx())
    expect(client.callCount).toBe(1)
    expect(out2.fromCache).toBe(true)
    expect(out2.is_real_threat).toBe(out1.is_real_threat)
    // Cached entries report zero cost
    expect(out2.costUsd).toBe(0)
    expect(out2.latencyMs).toBe(0)
  })

  it('different context triggers a fresh call', async () => {
    const client = new FakeLlmClient()
    const v = new LlmVerifier({ db, config: configWithFeature(), client })
    await v.verify(makeCtx({ sourceAgent: 'hermes' }))
    await v.verify(makeCtx({ sourceAgent: 'openclaw' }))
    expect(client.callCount).toBe(2)
  })
})

describe('LlmVerifier — graceful degradation', () => {
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

  it('returns skipped=llm_error when the model output fails to parse', async () => {
    const client = new FakeLlmClient()
    client.nextText = 'I think the answer is probably allow.'
    const v = new LlmVerifier({ db, config: configWithFeature(), client })
    const out = await v.verify(makeCtx())
    expect(out.skipped).toBe('llm_error')
  })

  it('returns skipped=llm_error when the provider throws', async () => {
    const client = new FakeLlmClient()
    client.nextText = { throw: new LlmProviderError('boom', 'anthropic') }
    const v = new LlmVerifier({ db, config: configWithFeature(), client })
    const out = await v.verify(makeCtx())
    expect(out.skipped).toBe('llm_error')
  })

  it('records a llm_usage row on successful call', async () => {
    const v = new LlmVerifier({
      db,
      config: configWithFeature(),
      client: new FakeLlmClient(),
    })
    await v.verify(makeCtx())
    const rows = db.select().from(await import('../../../src/db/schema.js').then((m) => m.llmUsage)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.feature).toBe('verification')
  })

  it('lets non-LLM errors bubble (no silent swallow)', async () => {
    const client = new FakeLlmClient()
    client.nextText = { throw: new RangeError('out of bounds') }
    const v = new LlmVerifier({ db, config: configWithFeature(), client })
    await expect(v.verify(makeCtx())).rejects.toThrow(RangeError)
  })

  it('budget assertion errors are caught and surfaced as skipped=budget_exhausted', async () => {
    // Pre-seed usage to push the next call over
    const config = configWithFeature()
    recordUsage(db, {
      provider: 'anthropic',
      model: 'm',
      feature: 'verification',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: config.budget.monthly_cap_usd,
      durationMs: 1,
    })
    const v = new LlmVerifier({
      db,
      config,
      client: new FakeLlmClient(),
    })
    const out = await v.verify(makeCtx())
    expect(out.skipped).toBe('budget_exhausted')
    expect(out).not.toBeInstanceOf(LlmBudgetExceededError) // returned, not thrown
  })
})

describe('combineAssessment', () => {
  function baseHeuristic(): RiskAssessment {
    return {
      factors: [factor()],
      totalScore: 60,
      bucket: 'high',
      recommendation: 'ask',
      llmVerification: null,
    }
  }

  function makeVerification(
    overrides: Partial<LlmVerification> = {},
  ): LlmVerification {
    return {
      is_real_threat: true,
      threat_type: 'credential_theft',
      confidence: 0.85,
      explanation_short: 'short',
      explanation_long: 'long',
      recommended_action: 'deny',
      additional_risk_score: 10,
      user_should_check: [],
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      costUsd: 0.001,
      latencyMs: 200,
      fromCache: false,
      ...overrides,
    }
  }

  it('returns heuristic unchanged when llm is null', () => {
    expect(combineAssessment(baseHeuristic(), null)).toEqual(baseHeuristic())
  })

  it('attaches llmVerification even when skipped, but keeps score/recommendation', () => {
    const llm = makeVerification({ skipped: 'budget_exhausted' })
    const out = combineAssessment(baseHeuristic(), llm)
    expect(out.totalScore).toBe(60)
    expect(out.recommendation).toBe('ask')
    expect(out.llmVerification).toBe(llm)
  })

  it('overrides recommendation when confidence >= 0.7', () => {
    const llm = makeVerification({ confidence: 0.7, recommended_action: 'deny' })
    const out = combineAssessment(baseHeuristic(), llm)
    expect(out.recommendation).toBe('deny')
  })

  it('keeps heuristic recommendation when confidence < 0.7', () => {
    const llm = makeVerification({ confidence: 0.5, recommended_action: 'allow' })
    const out = combineAssessment(baseHeuristic(), llm)
    expect(out.recommendation).toBe('ask') // heuristic unchanged
  })

  it('adjusts score by additional_risk_score and recomputes bucket', () => {
    const llm = makeVerification({ additional_risk_score: 30 }) // 60 + 30 = 90 → critical
    const out = combineAssessment(baseHeuristic(), llm)
    expect(out.totalScore).toBe(90)
    expect(out.bucket).toBe('critical')
  })

  it('clamps adjusted score to [0, 100]', () => {
    const high = combineAssessment(
      { ...baseHeuristic(), totalScore: 90 },
      makeVerification({ additional_risk_score: 30 }),
    )
    expect(high.totalScore).toBe(100)
    const low = combineAssessment(
      { ...baseHeuristic(), totalScore: 10 },
      makeVerification({ additional_risk_score: -30 }),
    )
    expect(low.totalScore).toBe(0)
  })
})
