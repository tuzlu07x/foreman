import { foremanSelfProtectionRule } from './risk-rules/foreman-self-protection.js'
import type { ForemanDb } from '../db/client.js'
import {
  firstAgentToAgent,
  injectionPatternRule,
  loopDetectionRule,
  networkPatternRule,
  previouslyDeniedPattern,
  responsibilityViolationRule,
  secretPatternRule,
  shellPatternRule,
} from './risk-rules/index.js'
import type { ResponsibilityPolicy, SessionLimits } from './policy-engine.js'
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

/** Commands that wreck the machine (`rm -rf /`, `mkfs` or `dd` onto a disk,
 *  a fork bomb): refused outright instead of asked about, so a tired tap on
 *  "allow" or a timeout that nobody sees can't let one through. An explicit
 *  `buckets.critical` in policy.yaml still decides for itself. */
export const CATASTROPHIC_RULES: ReadonlySet<string> = new Set([
  'shell_rm_rf_catastrophic',
  'shell_dd_to_disk',
  'shell_mkfs_on_disk',
  'shell_fork_bomb',
])

export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  secretPatternRule,
  networkPatternRule,
  shellPatternRule,
  injectionPatternRule,
  loopDetectionRule,
  firstAgentToAgent,
  previouslyDeniedPattern,
  responsibilityViolationRule,
  foremanSelfProtectionRule,
]

export interface RiskScorerOptions {
  /** Per-bucket recommendation overrides — typically supplied by the policy engine. */
  bucketOverrides?: () => BucketOverrides
  /** Resolves an agent id → its responsibility note. Wires the
   *  responsibility-violation rule (#300); when absent that rule no-ops. */
  getAgentResponsibility?: (agentId: string) => string | null
  /** Snapshot of the policy engine's responsibility_policies (#299). Per-call
   *  closure so YAML reloads take effect without rebuilding the scorer. */
  responsibilityPolicies?: () => ResponsibilityPolicy[]
  /** #529 — Snapshot of the policy engine's session_limits. Consumed by the
   *  loop-detection rule (advisory token-budget factor). Per-call closure
   *  so a policy.yaml reload moves the threshold without restart. */
  sessionLimits?: () => SessionLimits
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
    const ctx: RiskContext = {
      db: this.db,
      getAgentResponsibility: this.options.getAgentResponsibility,
      responsibilityPolicies: this.options.responsibilityPolicies,
      sessionLimits: this.options.sessionLimits,
    }
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
  const catastrophic =
    overrides?.critical === undefined && factors.some((f) => CATASTROPHIC_RULES.has(f.rule))
  const recommendation = catastrophic ? 'deny' : recommendationFor(bucket, overrides)
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
