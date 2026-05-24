import type { ForemanDb } from '../../db/client.js'
import type { ResponsibilityPolicy, SessionLimits } from '../policy-engine.js'

export interface RiskRequest {
  sourceAgent: string
  targetAgent?: string
  targetTool?: string
  args?: unknown
  /** Session correlator — required by loop-detection (C6) to bound history queries
   *  and offer the modal's `[k] halt session` hotkey. Optional so single-shot
   *  calls outside a session still evaluate cleanly. */
  sessionId?: string
}

export interface RiskContext {
  db: ForemanDb
  /** Resolve the responsibility note registered for an agent id. Used by the
   *  responsibility-violation rule (#300). Returns null when the agent is
   *  unknown or has no declared responsibility. Optional so deployments /
   *  unit-tests that don't wire this still evaluate other rules cleanly. */
  getAgentResponsibility?(agentId: string): string | null
  /** Snapshot of the policy engine's currently-loaded responsibility_policies
   *  block (#299). Per-call closure so a YAML reload takes effect without
   *  rebuilding the RiskScorer. */
  responsibilityPolicies?: () => ResponsibilityPolicy[]
  /** #529 — Snapshot of the policy engine's session_limits block. The
   *  loop-detection rule reads `tokenLimit` + `tokenBudgetWarningPct`
   *  through this closure so a policy.yaml reload moves the advisory
   *  threshold without rebuilding the scorer. When absent the rule
   *  falls back to its hardcoded 100K / 80% defaults. */
  sessionLimits?: () => SessionLimits
}

export type RiskCategory =
  | 'secret'
  | 'shell'
  | 'network'
  | 'injection'
  | 'loop'
  | 'structural'

export type RiskBucket = 'low' | 'medium' | 'high' | 'critical'

export type RiskRecommendation = 'allow' | 'ask' | 'deny'

export interface RiskFactor {
  /** Stable id — e.g. secret_file_pattern, shell_destructive. */
  rule: string
  /** Severity contributed to the total score (negative subtracts — safe-list rules). */
  points: number
  /** One-line, human-language reason — "Reads .env file". */
  reason: string
  /** Optional supporting evidence — matched substring, regex, etc. */
  evidence?: string
  category: RiskCategory
}

// Threat categorisation from the C8 LLM verifier. Used to colour the modal
// and group similar threats in `foreman log search`.
export type ThreatType =
  | 'prompt_injection'
  | 'data_exfil'
  | 'privilege_escalation'
  | 'credential_theft'
  | 'loop_attack'
  | 'social_engineering'
  | 'false_positive'
  | 'user_initiated_legitimate'

// Populated by the C8 LLM verification layer (#231). When the verifier
// short-circuits (feature off, below threshold, budget exhausted, cache hit
// during regression, LLM error) `skipped` carries the reason and the rich
// fields are filled with conservative defaults so downstream consumers can
// still render something. When skipped is undefined, the model produced
// real output.
export interface LlmVerification {
  is_real_threat: boolean
  threat_type: ThreatType
  /** 0.0–1.0. Combine logic only overrides the heuristic when ≥ 0.7. */
  confidence: number
  /** ≤ 90 chars — the modal one-liner. */
  explanation_short: string
  /** 2-3 sentences for the inspect view + Telegram body. */
  explanation_long: string
  recommended_action: 'allow' | 'ask' | 'deny'
  /** -30..+30 added to the heuristic score before bucket recompute. */
  additional_risk_score: number
  user_should_check: string[]

  // Audit metadata — written to llm_usage too, but kept on the verification
  // row so log queries don't need a JOIN.
  provider: string
  model: string
  costUsd: number
  latencyMs: number
  fromCache: boolean
  /** Present only when the verifier short-circuited. */
  skipped?:
    | 'budget_exhausted'
    | 'llm_error'
    | 'feature_disabled'
    | 'below_threshold'
}

export interface RiskAssessment {
  factors: RiskFactor[]
  /** 0–100, clamped. */
  totalScore: number
  bucket: RiskBucket
  recommendation: RiskRecommendation
  llmVerification: LlmVerification | null
}

export interface RiskRule {
  /** Stable name written to factors[].rule */
  name: string
  category: RiskCategory
  evaluate(req: RiskRequest, ctx: RiskContext): RiskFactor[]
}

export function extractPath(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const path = (args as { path?: unknown }).path
  return typeof path === 'string' ? path : null
}
