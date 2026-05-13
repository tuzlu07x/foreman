import { and, eq, sql } from 'drizzle-orm'
import { requests } from '../../db/schema.js'
import type { RiskRule } from './types.js'

export const previouslyDeniedPattern: RiskRule = {
  name: 'previously_denied_pattern',
  evaluate(req, ctx) {
    if (!req.targetTool) return null
    const row = ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(
        and(
          eq(requests.sourceAgent, req.sourceAgent),
          eq(requests.targetTool, req.targetTool),
          eq(requests.decision, 'denied'),
        ),
      )
      .get()
    if ((row?.count ?? 0) > 0) {
      return {
        points: 30,
        reason: `previously denied: ${req.sourceAgent} → ${req.targetTool}`,
      }
    }
    return null
  },
}
