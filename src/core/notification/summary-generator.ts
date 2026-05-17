import { and, eq, gte, sql } from 'drizzle-orm'
import type { ForemanDb } from '../../db/client.js'
import { notifications, requests } from '../../db/schema.js'
import type { LlmClient } from '../llm/client.js'
import {
  detectLocaleFromEnv,
  narrateSummary,
  type SummaryLocale,
} from '../llm/summary-narrator.js'
import type { Notification } from './types.js'

// =============================================================================
// Daily summary generator (#235 / C11c)
// =============================================================================
//
// Builds a "what happened in the last N hours" digest from the audit log.
// Honest-fallback template only — C8 LLM verification + C9 SmartReport
// haven't shipped yet. When they land, this module gains an optional `llm`
// dep and the prose narrative becomes a model call. Today: counts + a few
// highlighted lines, end with "Enable smart analysis with `foreman llm
// enable` for richer reports."

export interface SummaryOptions {
  /** How far back to look. Default: 12h (matches the spec example). */
  windowMs?: number
  /** Override the "now" timestamp — used by tests for determinism. */
  now?: number
}

export interface SummaryStats {
  totalCalls: number
  highRiskCalls: number
  agentsActive: string[]
  decisionsAllowed: number
  decisionsDenied: number
  notificationsSent: number
}

export function generateSummary(
  db: ForemanDb,
  opts: SummaryOptions = {},
): Omit<Notification, 'id'> {
  const now = opts.now ?? Date.now()
  const windowMs = opts.windowMs ?? 12 * 60 * 60 * 1000
  const cutoff = now - windowMs

  const stats = computeStats(db, cutoff, now)
  const body = formatBody(stats, windowMs)

  return {
    level: 'summary',
    requestId: null,
    title: `📊 Foreman summary — last ${humanWindow(windowMs)}`,
    body,
    actions: [],
    agentBlocking: false,
  }
}

function computeStats(
  db: ForemanDb,
  cutoff: number,
  now: number,
): SummaryStats {
  // 1. Total calls + decisions
  const requestRows = db
    .select({
      sourceAgent: requests.sourceAgent,
      decision: requests.decision,
      riskBucket: requests.riskBucket,
    })
    .from(requests)
    .where(gte(requests.createdAt, cutoff))
    .all()

  const agents = new Set<string>()
  let allowed = 0
  let denied = 0
  let highRisk = 0
  for (const r of requestRows) {
    agents.add(r.sourceAgent)
    if (r.decision === 'allowed') allowed += 1
    else if (r.decision === 'denied') denied += 1
    if (r.riskBucket === 'high' || r.riskBucket === 'critical') highRisk += 1
  }

  // 2. Notifications dispatched in the window
  const notifyCount = db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(
        gte(notifications.sentAt, cutoff),
        // Skip prior digests themselves so the count stays meaningful.
        // Drizzle's `ne` would also work; sql template is fine here.
        sql`${notifications.level} != 'summary'`,
      ),
    )
    .get()

  void now // reserved for future "this hour vs prior hour" deltas
  return {
    totalCalls: requestRows.length,
    highRiskCalls: highRisk,
    agentsActive: [...agents].sort(),
    decisionsAllowed: allowed,
    decisionsDenied: denied,
    notificationsSent: notifyCount?.n ?? 0,
  }
}

function formatBody(stats: SummaryStats, windowMs: number): string {
  const lines: string[] = []
  const window = humanWindow(windowMs)

  if (stats.totalCalls === 0) {
    lines.push(`No tool calls in the last ${window}.`)
    lines.push('')
    lines.push('No news is good news — your agents have been quiet.')
    return lines.join('\n')
  }

  lines.push(
    `- ${stats.totalCalls} tool calls across ${stats.agentsActive.length} agent${
      stats.agentsActive.length === 1 ? '' : 's'
    }`,
  )
  lines.push(`- ${stats.decisionsAllowed} allowed, ${stats.decisionsDenied} denied`)
  if (stats.highRiskCalls > 0) {
    lines.push(`- ${stats.highRiskCalls} high-risk call${stats.highRiskCalls === 1 ? '' : 's'} flagged`)
  } else {
    lines.push('- 0 high-risk calls (good!)')
  }
  if (stats.notificationsSent > 0) {
    lines.push(`- ${stats.notificationsSent} notification${stats.notificationsSent === 1 ? '' : 's'} delivered`)
  }

  if (stats.agentsActive.length > 0) {
    lines.push('')
    lines.push('Active agents:')
    for (const a of stats.agentsActive) lines.push(`  • ${a}`)
  }

  lines.push('')
  lines.push(
    'Smart analysis is off. Enable with `foreman llm enable` for contextual reports.',
  )
  return lines.join('\n')
}

function humanWindow(ms: number): string {
  const hours = ms / 3_600_000
  if (hours >= 48) return `${Math.round(hours / 24)} days`
  if (hours >= 1) return `${Math.round(hours)} hours`
  const minutes = Math.round(ms / 60_000)
  return `${minutes} minutes`
}

// =============================================================================
// Smart variant — LLM-powered narrative when available (#306)
// =============================================================================
//
// Wraps generateSummary, runs the configured LLM client over the same
// stats, and replaces the body with the narrative on success. Every failure
// mode (LLM disabled / no client / empty stats / API error) falls back to
// the template body so the digest always lands.

export interface SmartSummaryOptions extends SummaryOptions {
  /** When null, smart narration is skipped and the template body is used.
   *  Caller usually passes the same client built for verification. */
  llmClient?: LlmClient | null
  locale?: SummaryLocale
  /** Override env detection for locale. */
  env?: NodeJS.ProcessEnv
  /** Per-agent responsibility note map for richer "Hermes (code writing)"
   *  framing in the narrative. */
  responsibilities?: Record<string, string | null>
  budget?: {
    spentUsd: number
    capUsd: number
    alertTripped?: boolean
  }
}

export async function generateSmartSummaryPayload(
  db: ForemanDb,
  opts: SmartSummaryOptions = {},
): Promise<Omit<Notification, 'id'>> {
  const payload = generateSummary(db, opts)
  if (!opts.llmClient) return payload
  const stats = computeStats(
    db,
    (opts.now ?? Date.now()) - (opts.windowMs ?? 12 * 60 * 60 * 1000),
    opts.now ?? Date.now(),
  )
  const factorCounts = computeFactorCounts(
    db,
    (opts.now ?? Date.now()) - (opts.windowMs ?? 12 * 60 * 60 * 1000),
  )
  const locale = opts.locale ?? detectLocaleFromEnv(opts.env)
  const outcome = await narrateSummary({
    client: opts.llmClient,
    stats,
    windowLabel: humanWindow(opts.windowMs ?? 12 * 60 * 60 * 1000),
    responsibilities: opts.responsibilities,
    budget: opts.budget,
    factorCounts,
    locale,
  })
  if (outcome.status !== 'ok') return payload
  return { ...payload, body: outcome.text }
}

function computeFactorCounts(
  db: ForemanDb,
  cutoff: number,
): Record<string, number> {
  const rows = db
    .select({ riskFactors: requests.riskFactors })
    .from(requests)
    .where(gte(requests.createdAt, cutoff))
    .all()
  const counts: Record<string, number> = {}
  for (const r of rows) {
    if (!r.riskFactors) continue
    try {
      const parsed = JSON.parse(r.riskFactors) as Array<{ rule?: string }>
      if (!Array.isArray(parsed)) continue
      for (const f of parsed) {
        if (typeof f.rule !== 'string') continue
        counts[f.rule] = (counts[f.rule] ?? 0) + 1
      }
    } catch {
      // Skip malformed rows — happens for legacy data; the template body
      // already handles those.
    }
  }
  return counts
}
