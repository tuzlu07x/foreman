import { and, eq, like, notLike, or, sql } from 'drizzle-orm'
import { requests } from '../../db/schema.js'
import { redactSecretsDeep } from './secret-patterns.js'
import type { RiskFactor, RiskRule } from './types.js'

export const previouslyDeniedPattern: RiskRule = {
  name: 'previously_denied_pattern',
  category: 'structural',
  evaluate(req, ctx): RiskFactor[] {
    if (!req.targetTool) return []
    // The same call, not merely the same tool: one denied `terraform
    // destroy` must not make every later `ls` ask. Arguments are compared
    // the way the audit log stores them (secrets masked).
    const sameArgs = JSON.stringify(redactSecretsDeep(req.args ?? {}))
    const row = ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(
        and(
          eq(requests.sourceAgent, req.sourceAgent),
          eq(requests.targetTool, req.targetTool),
          eq(requests.decision, 'denied'),
          eq(requests.args, sameArgs),
          // Only a person saying no counts (`user`, `user:tui`,
          // `user:telegram`, …). An approval nobody answered in time, a
          // requester that disconnected, a policy rule or a quarantine
          // says nothing about this call, and once you allow the tool it
          // shouldn't keep asking.
          or(eq(requests.decidedBy, 'user'), like(requests.decidedBy, 'user:%')),
          // A call the MCP hub withheld (a changed tool definition, #635)
          // says nothing about the agent either.
          notLike(requests.decidedBy, 'mcp:withheld:%'),
        ),
      )
      .get()
    if ((row?.count ?? 0) === 0) return []
    return [
      {
        rule: 'previously_denied_pattern',
        category: 'structural',
        points: 30,
        reason: `previously denied: ${req.sourceAgent} → ${req.targetTool} with the same arguments`,
      },
    ]
  },
}
