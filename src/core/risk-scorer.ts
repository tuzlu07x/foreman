import type { ForemanDb } from '../db/client.js'
import {
  firstAgentToAgent,
  outboundNetwork,
  previouslyDeniedPattern,
  secretPatternRule,
  shellExec,
} from './risk-rules/index.js'
import type {
  LlmVerification,
  RiskAssessment,
  RiskBucket,
  RiskContext,
  RiskFactor,
  RiskRecommendation,
  RiskRequest,
  RiskRule,
} from './risk-rules/types.js'

// Boundary between "auto-allow" (low) and "must ask" (medium). Pre-existing
// callers used this as a single boolean cliff; the assessment model replaces
// that with buckets but we keep the constant exported for backward compat.
export const RISK_THRESHOLD = 30

const BUCKET_THRESHOLDS: { bucket: RiskBucket; min: number }[] = [
  { bucket: 'critical', min: 85 },
  { bucket: 'high', min: 60 },
  { bucket: 'medium', min: 30 },
  { bucket: 'low', min: 0 },
]

const DEFAULT_RECOMMENDATIONS: Record<RiskBucket, RiskRecommendation> = {
  low: 'allow',
  medium: 'ask',
  high: 'ask',
  critical: 'ask',
}

export type BucketOverrides = Partial<Record<RiskBucket, RiskRecommendation>>

export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  secretPatternRule,
  outboundNetwork,
  shellExec,
  firstAgentToAgent,
  previouslyDeniedPattern,
]

export interface RiskScorerOptions {
  /** Per-bucket recommendation overrides — typically supplied by the policy engine. */
  bucketOverrides?: () => BucketOverrides
}

export function bucketFor(totalScore: number): RiskBucket {
  for (const { bucket, min } of BUCKET_THRESHOLDS) {
    if (totalScore >= min) return bucket
  }
  return 'low'
}

export function recommendationFor(
  bucket: RiskBucket,
  overrides?: BucketOverrides,
): RiskRecommendation {
  return overrides?.[bucket] ?? DEFAULT_RECOMMENDATIONS[bucket]
}

export class RiskScorer {
  constructor(
    private readonly db: ForemanDb,
    private readonly rules: readonly RiskRule[] = DEFAULT_RISK_RULES,
    private readonly options: RiskScorerOptions = {},
  ) {}

  assess(req: RiskRequest): RiskAssessment {
    const ctx: RiskContext = { db: this.db }
    const factors: RiskFactor[] = []
    for (const rule of this.rules) {
      const produced = rule.evaluate(req, ctx)
      for (const f of produced) factors.push(f)
    }
    return composeAssessment(factors, this.options.bucketOverrides?.())
  }
}

export function composeAssessment(
  factors: RiskFactor[],
  overrides?: BucketOverrides,
  llmVerification: LlmVerification | null = null,
): RiskAssessment {
  const raw = factors.reduce((sum, f) => sum + f.points, 0)
  const totalScore = Math.max(0, Math.min(100, raw))
  const bucket = bucketFor(totalScore)
  const recommendation = recommendationFor(bucket, overrides)
  return { factors, totalScore, bucket, recommendation, llmVerification }
}

export type {
  LlmVerification,
  RiskAssessment,
  RiskBucket,
  RiskCategory,
  RiskContext,
  RiskFactor,
  RiskRecommendation,
  RiskRequest,
  RiskRule,
} from './risk-rules/types.js'
