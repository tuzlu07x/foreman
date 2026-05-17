import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ForemanDb } from '../../db/client.js'
import { auditEvents, llmUsage } from '../../db/schema.js'
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from '../event-bus.js'
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

/**
 * Wraps `recordUsage` with budget-threshold detection. Emits `llm:budget-alert`
 * the first time spending crosses the alert threshold (and again on 100%
 * exhaustion) within the current billing window. Tracks "already fired" by
 * scanning `audit_events` for a matching row in the same window — no extra
 * table needed and the audit row is the source of truth for the digest +
 * `foreman llm usage` history.
 */
export function recordUsageAndCheckBudget(
  db: ForemanDb,
  config: LlmConfig,
  row: UsageRow,
  bus: EventBus<ForemanEventMap> = defaultBus,
  now: number = Date.now(),
): { usageId: string; alertFired: BudgetAlertKind | null } {
  const usageId = recordUsage(db, row)
  // Cached calls don't add to spend (`costUsd` is 0 by contract) — short-circuit.
  if ((row.costUsd ?? 0) <= 0 || row.cacheHit) {
    return { usageId, alertFired: null }
  }
  const status = getBudgetStatus(db, config, now)
  const kind: BudgetAlertKind | null =
    status.spentUsd >= status.capUsd
      ? 'exhausted'
      : status.spentPct >= config.budget.alert_threshold_pct
        ? 'threshold'
        : null
  if (!kind) return { usageId, alertFired: null }

  if (hasAlertFiredInWindow(db, status.windowStart, kind)) {
    return { usageId, alertFired: null }
  }

  const payload: ForemanEventMap['llm:budget-alert'] = {
    kind,
    spentUsd: status.spentUsd,
    capUsd: status.capUsd,
    spentPct: status.spentPct,
    windowStart: status.windowStart,
    windowEnd: status.windowEnd,
    daysUntilReset: Math.max(
      0,
      Math.ceil((status.windowEnd - now) / 86_400_000),
    ),
  }
  db.insert(auditEvents)
    .values({
      eventType: 'llm_budget_alert',
      payload: JSON.stringify(payload),
      createdAt: now,
    })
    .run()
  bus.emit('llm:budget-alert', payload)
  return { usageId, alertFired: kind }
}

export type BudgetAlertKind = 'threshold' | 'exhausted'

function hasAlertFiredInWindow(
  db: ForemanDb,
  windowStart: number,
  kind: BudgetAlertKind,
): boolean {
  const rows = db
    .select({ id: auditEvents.id, payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, 'llm_budget_alert'),
        gte(auditEvents.createdAt, windowStart),
      ),
    )
    .all()
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload ?? '{}') as { kind?: string }
      if (p.kind === kind) return true
    } catch {
      /* skip malformed */
    }
  }
  return false
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

export interface UsageQuery {
  /** Inclusive epoch-ms lower bound. */
  since?: number
  /** Exact feature name match (verification / smart_report / test / ...). */
  feature?: string
  limit?: number
}

export function queryUsage(
  db: ForemanDb,
  q: UsageQuery = {},
): (typeof llmUsage.$inferSelect)[] {
  const clauses = []
  if (q.since !== undefined) clauses.push(gte(llmUsage.ts, q.since))
  if (q.feature !== undefined) clauses.push(eq(llmUsage.feature, q.feature))
  const where = clauses.length === 0 ? undefined : and(...clauses)
  const query = db.select().from(llmUsage)
  const filtered = where ? query.where(where) : query
  return filtered.orderBy(desc(llmUsage.ts)).limit(q.limit ?? 30).all()
}

export interface FeatureSplit {
  feature: string
  spentUsd: number
  callCount: number
  cachedCount: number
}

/**
 * Per-feature cost breakdown for the current billing window. Drives the
 * `foreman llm budget` summary and the TUI settings tile.
 */
export function featureSplit(
  db: ForemanDb,
  config: LlmConfig,
  now: number = Date.now(),
): FeatureSplit[] {
  const { windowStart } = currentWindow(config, now)
  const rows = db
    .select({
      feature: llmUsage.feature,
      spent: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)`,
      calls: sql<number>`count(*)`,
      cached: sql<number>`coalesce(sum(${llmUsage.cacheHit}), 0)`,
    })
    .from(llmUsage)
    .where(gte(llmUsage.ts, windowStart))
    .groupBy(llmUsage.feature)
    .all()
  return rows
    .map((r) => ({
      feature: r.feature,
      spentUsd: r.spent ?? 0,
      callCount: r.calls ?? 0,
      cachedCount: r.cached ?? 0,
    }))
    .sort((a, b) => b.spentUsd - a.spentUsd)
}

/** Human "Nd" / "Nh" / "Nm" → ms; throws on invalid input. */
export function parseSince(input: string): number {
  const m = input.match(/^(\d+)\s*([dhm])$/i)
  if (!m) {
    throw new Error(`invalid --since value: ${input} (expected Nd / Nh / Nm)`)
  }
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const ms = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000
  return n * ms
}
