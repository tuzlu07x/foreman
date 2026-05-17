import { and, desc, gte, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ForemanDb } from '../../db/client.js'
import { llmUsage } from '../../db/schema.js'
import { LlmBudgetExceededError } from './client.js'
import type { LlmConfig } from './config.js'

// =============================================================================
// LLM budget tracker (#230 / C7)
// =============================================================================
//
// Sums llm_usage.cost_usd over the current billing window (reset_day_of_month
// → next reset). Provides:
//
//   - `getBudgetStatus(db, config, now?)` — for `foreman llm budget --status`
//   - `recordUsage(db, row)` — every LlmClient call MUST call this so the
//     window stays accurate
//   - `assertBudget(db, config)` — throws LlmBudgetExceededError when over
//     the cap. C8 verification / C9 smart-report call this before invoking
//     the client.

export interface BudgetStatus {
  spentUsd: number
  capUsd: number
  remainingUsd: number
  spentPct: number
  alertTripped: boolean
  windowStart: number
  windowEnd: number
}

export function getBudgetStatus(
  db: ForemanDb,
  config: LlmConfig,
  now: number = Date.now(),
): BudgetStatus {
  const { windowStart, windowEnd } = currentWindow(config, now)
  const row = db
    .select({
      total: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)`,
    })
    .from(llmUsage)
    .where(and(gte(llmUsage.ts, windowStart)))
    .get()
  const spentUsd = row?.total ?? 0
  const capUsd = config.budget.monthly_cap_usd
  const remainingUsd = Math.max(0, capUsd - spentUsd)
  const spentPct = capUsd > 0 ? Math.min(100, (spentUsd / capUsd) * 100) : 0
  return {
    spentUsd,
    capUsd,
    remainingUsd,
    spentPct,
    alertTripped: spentPct >= config.budget.alert_threshold_pct,
    windowStart,
    windowEnd,
  }
}

export interface UsageRow {
  ts?: number
  provider: string
  model: string
  feature: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  requestId?: string
  durationMs: number
  cacheHit?: boolean
}

export function recordUsage(db: ForemanDb, row: UsageRow): string {
  const id = ulid()
  db.insert(llmUsage)
    .values({
      id,
      ts: row.ts ?? Date.now(),
      provider: row.provider,
      model: row.model,
      feature: row.feature,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd,
      requestId: row.requestId ?? null,
      durationMs: row.durationMs,
      cacheHit: row.cacheHit ? 1 : 0,
    })
    .run()
  return id
}

/** Called by C8/C9 right before invoking the LLM. */
export function assertBudget(db: ForemanDb, config: LlmConfig): void {
  const status = getBudgetStatus(db, config)
  if (status.spentUsd >= status.capUsd) {
    throw new LlmBudgetExceededError(status.spentUsd, status.capUsd)
  }
}

// ============================================================================
// Billing window math — local-time month boundary with configurable reset day
// ============================================================================
//
// Example: reset_day_of_month=1 → window starts on the 1st of this month at
// 00:00 local, ends at the 1st of next month. Reset day 15 → window is
// the 15th this month to the 15th next month.
//
// We assume `Date` uses local time (Node default). For tests, inject `now`.

export function currentWindow(
  config: LlmConfig,
  now: number,
): { windowStart: number; windowEnd: number } {
  const resetDay = Math.min(28, Math.max(1, config.budget.reset_day_of_month))
  const today = new Date(now)
  const year = today.getFullYear()
  const month = today.getMonth()
  const dayOfMonth = today.getDate()

  let startMonth = month
  let startYear = year
  if (dayOfMonth < resetDay) {
    // We're before this month's reset day — window started last month.
    startMonth = month - 1
    if (startMonth < 0) {
      startMonth = 11
      startYear -= 1
    }
  }
  const windowStart = new Date(startYear, startMonth, resetDay, 0, 0, 0, 0).getTime()
  const endDate = new Date(startYear, startMonth + 1, resetDay, 0, 0, 0, 0)
  const windowEnd = endDate.getTime()
  return { windowStart, windowEnd }
}

// ============================================================================
// Recent calls for `foreman llm usage`
// ============================================================================

export function recentUsage(
  db: ForemanDb,
  limit = 30,
): (typeof llmUsage.$inferSelect)[] {
  return db
    .select()
    .from(llmUsage)
    .orderBy(desc(llmUsage.ts))
    .limit(limit)
    .all()
}
