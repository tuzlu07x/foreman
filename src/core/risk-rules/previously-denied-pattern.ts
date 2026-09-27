import { and, eq, isNull, notLike, or, sql } from 'drizzle-orm'
import { requests } from '../../db/schema.js'
import type { RiskFactor, RiskRule } from './types.js'

export const previouslyDeniedPattern: RiskRule = {
  name: 'previously_denied_pattern',
  category: 'structural',
  evaluate(req, ctx): RiskFactor[] {
    if (!req.targetTool) return []
    const row = ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(
        and(
          eq(requests.sourceAgent, req.sourceAgent),
          eq(requests.targetTool, req.targetTool),
          eq(requests.decision, 'denied'),
          // A call the MCP hub withheld (a changed tool definition, #635)
          // says nothing about the agent; once you trust the server again
          // it shouldn't keep costing points.
          or(isNull(requests.decidedBy), notLike(requests.decidedBy, 'mcp:withheld:%')),
        ),
      )
      .get()
    if ((row?.count ?? 0) === 0) return []
    return [
      {
        rule: 'previously_denied_pattern',
        category: 'structural',
        points: 30,
        reason: `previously denied: ${req.sourceAgent} → ${req.targetTool}`,
      },
    ]
  },
}
