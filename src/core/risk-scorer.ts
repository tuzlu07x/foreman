import type { ForemanDb } from '../db/client.js'
import {
  firstAgentToAgent,
  outboundNetwork,
  previouslyDeniedPattern,
  secretFilePattern,
  shellExec,
} from './risk-rules/index.js'
import type { RiskContext, RiskRequest, RiskRule } from './risk-rules/types.js'

export const RISK_THRESHOLD = 50

export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  secretFilePattern,
  outboundNetwork,
  shellExec,
  firstAgentToAgent,
  previouslyDeniedPattern,
]

export interface RiskResult {
  score: number
  reasons: string[]
  /** Details for the TUI inspector (#20) — same length as `reasons`. */
  hits: { name: string; points: number; reason: string }[]
}

export class RiskScorer {
  constructor(
    private readonly db: ForemanDb,
    private readonly rules: readonly RiskRule[] = DEFAULT_RISK_RULES,
  ) {}

  score(req: RiskRequest): RiskResult {
    const ctx: RiskContext = { db: this.db }
    let score = 0
    const reasons: string[] = []
    const hits: RiskResult['hits'] = []
    for (const rule of this.rules) {
      const hit = rule.evaluate(req, ctx)
      if (hit) {
        score += hit.points
        reasons.push(rule.name)
        hits.push({ name: rule.name, points: hit.points, reason: hit.reason })
      }
    }
    return { score, reasons, hits }
  }
}

export type { RiskContext, RiskRequest, RiskRule } from './risk-rules/types.js'
