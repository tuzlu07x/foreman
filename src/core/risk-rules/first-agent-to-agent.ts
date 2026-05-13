import { and, eq, gte, sql } from 'drizzle-orm'
import { requests } from '../../db/schema.js'
import type { RiskRule } from './types.js'

const ONE_HOUR_MS = 60 * 60 * 1000

export const firstAgentToAgent: RiskRule = {
  name: 'first_agent_to_agent',
  evaluate(req, ctx) {
    if (!req.targetAgent) return null
    const since = Date.now() - ONE_HOUR_MS
    const row = ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(
        and(
          eq(requests.sourceAgent, req.sourceAgent),
          eq(requests.targetAgent, req.targetAgent),
          gte(requests.createdAt, since),
        ),
      )
      .get()
    if ((row?.count ?? 0) === 0) {
      return {
        points: 20,
        reason: `first ${req.sourceAgent} → ${req.targetAgent} call in the last hour`,
      }
    }
    return null
  },
}
