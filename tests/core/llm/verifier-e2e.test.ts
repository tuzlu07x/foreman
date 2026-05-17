import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ApprovalDecision,
  type ApprovalService,
} from '../../../src/core/approval.js'
import { AuditLogger } from '../../../src/core/audit.js'
import { EventBus, type ForemanEventMap } from '../../../src/core/event-bus.js'
import {
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from '../../../src/core/llm/client.js'
import { defaultLlmConfig } from '../../../src/core/llm/config.js'
import { LlmVerifier } from '../../../src/core/llm/verifier.js'
import { MediatorService } from '../../../src/core/mediator.js'
import { PolicyEngine } from '../../../src/core/policy-engine.js'
import { RegistryService } from '../../../src/core/registry.js'
import { RiskScorer } from '../../../src/core/risk-scorer.js'
import { createInMemoryDb, type ForemanDb } from '../../../src/db/client.js'
import { requests } from '../../../src/db/schema.js'

class FakeLlmClient implements LlmClient {
  readonly providerId = 'anthropic' as const
  readonly model = 'claude-haiku-4-5'
  nextText: string = JSON.stringify({
    is_real_threat: true,
    threat_type: 'credential_theft',
    confidence: 0.9,
    explanation_short: 'Phishing chain + .env read',
    explanation_long: 'Strong indicators of credential theft.',
    recommended_action: 'deny',
    additional_risk_score: 5,
    user_should_check: ['Sender of triggering email'],
  })
  async ping(): Promise<LlmResponse> {
    return this.call('ping', { feature: 'test', maxTokens: 4 })
  }
  async call(_prompt: string, _opts: LlmCallOptions): Promise<LlmResponse> {
    return {
      text: this.nextText,
      inputTokens: 200,
      outputTokens: 80,
      costUsd: 0.0012,
      durationMs: 180,
      cacheHit: false,
    }
  }
}

function configWithVerification(): ReturnType<typeof defaultLlmConfig> {
  const c = defaultLlmConfig()
  c.enabled = true
  c.features.verification = true
  return c
}

describe('Verifier end-to-end via MediatorService (#231 acceptance)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let bus: EventBus<ForemanEventMap>
  let audit: AuditLogger
  let mediator: MediatorService
  let verifier: LlmVerifier
  let client: FakeLlmClient

  beforeEach(() => {
    const handle = createInMemoryDb()
    db = handle.db
    sqlite = handle.sqlite
    bus = new EventBus<ForemanEventMap>()
    audit = new AuditLogger(db, bus)
    const registry = new RegistryService(db, bus)
    const policy = new PolicyEngine(db, bus)
    const risk = new RiskScorer(db, undefined, {
      bucketOverrides: () => policy.getBucketOverrides(),
    })
    const approval: ApprovalService = {
      request: vi.fn(
        async (): Promise<ApprovalDecision> => ({ decision: 'denied' }),
      ),
    }
    client = new FakeLlmClient()
    verifier = new LlmVerifier({
      db,
      config: configWithVerification(),
      client,
    })
    mediator = new MediatorService({
      registry,
      policy,
      risk,
      approval,
      bus,
      verifier,
    })
  })

  afterEach(() => {
    audit.dispose()
    sqlite.close()
  })

  it('persists llm_verification on the audit row when verifier runs', async () => {
    const out = await mediator.handleRequest({
      requestId: 'r-verif-1',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '.env' } },
      } as never,
    })
    expect(out.llmVerification).not.toBeNull()
    expect(out.llmVerification!.skipped).toBeUndefined()
    expect(out.llmVerification!.threat_type).toBe('credential_theft')

    audit.flush()
    const row = db
      .select()
      .from(requests)
      .all()
      .find((r) => r.id === 'r-verif-1')!
    const persisted = JSON.parse(row.llmVerification ?? 'null') as {
      threat_type: string
      recommended_action: string
      confidence: number
    } | null
    expect(persisted).not.toBeNull()
    expect(persisted!.threat_type).toBe('credential_theft')
    expect(persisted!.recommended_action).toBe('deny')
  })

  it('LLM verdict + high confidence → recommendation overrides heuristic', async () => {
    // Heuristic: .env read scores 60 → ask. LLM says deny with confidence 0.9 → override.
    client.nextText = JSON.stringify({
      is_real_threat: true,
      threat_type: 'credential_theft',
      confidence: 0.95,
      explanation_short: 'Definite theft',
      explanation_long: 'Whole chain looks like exfil.',
      recommended_action: 'deny',
      additional_risk_score: 20,
      user_should_check: [],
    })

    const out = await mediator.handleRequest({
      requestId: 'r-override',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '.env' } },
      } as never,
    })
    // Heuristic: secret_path (+60) + first_agent_to_agent (+20) = 80.
    // LLM additional_risk_score +20 → 100 (clamped). LLM rec 'deny' wins
    // (confidence 0.95 ≥ 0.7) → mediator short-circuits via the deny path.
    expect(out.decision).toBe('denied')
    expect(out.decidedBy).toContain('risk:')
    expect(out.riskBucket).toBe('critical')
  })

  it('LLM "false_positive" verdict with high confidence → recommendation drops to allow', async () => {
    client.nextText = JSON.stringify({
      is_real_threat: false,
      threat_type: 'user_initiated_legitimate',
      confidence: 0.9,
      explanation_short: 'User explicitly asked to read .env',
      explanation_long: 'Direct user command, no exfil context.',
      recommended_action: 'allow',
      additional_risk_score: -20,
      user_should_check: [],
    })

    const out = await mediator.handleRequest({
      requestId: 'r-fp',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '.env' } },
      } as never,
    })
    // The LLM verification gets attached + influences the assessment, but
    // with no policy loaded `policyResult.decision === 'ask'` still triggers
    // the modal — the DenyAll approval mock returns denied. v0.1 design:
    // policy.ask is an explicit user gate; LLM only overrides the heuristic
    // recommendation, not policy. (C9 modal will surface the LLM's "allow"
    // hint to the user so they don't blindly approve.)
    expect(out.decision).toBe('denied')
    expect(out.llmVerification!.recommended_action).toBe('allow')
    expect(out.llmVerification!.confidence).toBe(0.9)
    // Score adjusted down by 20 → 60 (still high bucket)
    expect(out.riskScore).toBe(60)
    expect(out.riskBucket).toBe('high')
  })

  it('verifier failure does not crash the mediator (heuristic-only fallback)', async () => {
    client.nextText = 'not json at all'
    const out = await mediator.handleRequest({
      requestId: 'r-fallback',
      sourceAgent: 'hermes',
      targetAgent: 'claude-code',
      targetTool: 'read_file',
      message: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '.env' } },
      } as never,
    })
    // skipped='llm_error' — but the call still went through approval gate
    expect(out.llmVerification?.skipped).toBe('llm_error')
    expect(out.decision).toBe('denied') // DenyAll approval
  })
})
