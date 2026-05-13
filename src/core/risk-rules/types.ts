import type { ForemanDb } from '../../db/client.js'

export interface RiskRequest {
  sourceAgent: string
  targetAgent?: string
  targetTool?: string
  args?: unknown
}

export interface RiskContext {
  db: ForemanDb
}

export interface RuleHit {
  points: number
  reason: string
}

export interface RiskRule {
  name: string
  evaluate(req: RiskRequest, ctx: RiskContext): RuleHit | null
}

export function extractPath(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const path = (args as { path?: unknown }).path
  return typeof path === 'string' ? path : null
}
