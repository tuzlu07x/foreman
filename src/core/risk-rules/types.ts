import type { ForemanDb } from '../../db/client.js'

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

// Populated by the C8 LLM verification layer; null when not run. Shape will
// be tightened when #231 lands — kept loose here so the migration column has
// a target type and downstream readers can be wired up incrementally.
export interface LlmVerification {
  verdict: 'confirms' | 'overrides' | 'inconclusive'
  reason: string
  provider: string
  model: string
  durationMs: number
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
