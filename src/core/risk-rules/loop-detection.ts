import { and, desc, eq, gte } from 'drizzle-orm'
import { requests, sessions } from '../../db/schema.js'
import type {
  RiskContext,
  RiskFactor,
  RiskRequest,
  RiskRule,
} from './types.js'

// =============================================================================
// LOOP / SESSION ANOMALY DETECTION (#229 / C6)
// =============================================================================
//
// The only rule family that looks at PATTERNS across calls. Single-call
// detection is the job of secret / shell / network / injection rules — this
// rule catches the runaway loop, the ping-pong, the token blowout that no
// single call would reveal.
//
// All thresholds are exported so tests + a future policy override can read
// them.

export const LOOP_THRESHOLDS = {
  /** How many recent calls to consider when building the call graph. */
  historyWindow: 10,
  /** Min consecutive A↔B turns before ping-pong fires. */
  pingPongMinTurns: 4,
  /** Burst threshold: ≥N calls from the same source in the burst window. */
  burstCount: 30,
  /** Burst window in ms. */
  burstWindowMs: 60_000,
  /** Loose-budget warning fires at ≥80% of the session token limit. */
  tokenBudgetWarnRatio: 0.8,
} as const

const POINTS = {
  pingPong: 50,
  cycle: 60,
  burst: 45,
  tokenBudget: 40,
} as const

// =============================================================================
// History row — narrow projection of the columns these patterns need
// =============================================================================

interface CallRow {
  sourceAgent: string
  targetAgent: string | null
  createdAt: number
}

function loadHistory(ctx: RiskContext, cutoff: number): CallRow[] {
  // Pull the most recent `historyWindow * 2` rows across all sources — burst
  // filters down by sourceAgent on its own, cycle benefits from the wider
  // view. Order by createdAt DESC + id DESC as tiebreaker (ULIDs are
  // monotonic) so same-millisecond inserts still get a stable order and
  // ping-pong / cycle aren't flaky on rapid turns.
  return ctx.db
    .select({
      sourceAgent: requests.sourceAgent,
      targetAgent: requests.targetAgent,
      createdAt: requests.createdAt,
    })
    .from(requests)
    .where(gte(requests.createdAt, cutoff))
    .orderBy(desc(requests.createdAt), desc(requests.id))
    .limit(LOOP_THRESHOLDS.historyWindow * 2)
    .all()
    .map((r) => ({
      sourceAgent: r.sourceAgent,
      targetAgent: r.targetAgent,
      createdAt: r.createdAt,
    }))
}

// =============================================================================
// 1. Ping-pong — A → B → A → B alternation (≥ pingPongMinTurns)
// =============================================================================

function pingPong(
  history: readonly CallRow[],
  req: RiskRequest,
): RiskFactor | null {
  if (!req.targetAgent) return null
  // Synthesise the in-flight call at the front so the pattern can include it.
  const window: CallRow[] = [
    {
      sourceAgent: req.sourceAgent,
      targetAgent: req.targetAgent,
      createdAt: Date.now(),
    },
    ...history,
  ].slice(0, LOOP_THRESHOLDS.historyWindow)

  // Walk newest→oldest. Count alternating same-pair calls.
  const pair = new Set([req.sourceAgent, req.targetAgent])
  let consecutive = 0
  let lastSource: string | null = null
  for (const row of window) {
    if (!row.targetAgent) break
    if (!pair.has(row.sourceAgent) || !pair.has(row.targetAgent)) break
    if (row.sourceAgent === lastSource) break // not alternating
    lastSource = row.sourceAgent
    consecutive += 1
  }
  if (consecutive < LOOP_THRESHOLDS.pingPongMinTurns) return null
  const names = [...pair].join(' ↔ ')
  return {
    rule: 'loop_pingpong',
    category: 'loop',
    points: POINTS.pingPong,
    reason: `Ping-pong loop (${consecutive} consecutive turns between ${names})`,
    evidence: names,
  }
}

// =============================================================================
// 2. Cycle — directed cycle A → B → C → A in the recent call graph
// =============================================================================

function detectCycle(
  history: readonly CallRow[],
  req: RiskRequest,
): RiskFactor | null {
  if (!req.targetAgent) return null

  // Build adjacency from the in-flight call + recent calls.
  const edges = new Map<string, Set<string>>()
  function addEdge(from: string, to: string): void {
    let set = edges.get(from)
    if (!set) {
      set = new Set()
      edges.set(from, set)
    }
    set.add(to)
  }
  addEdge(req.sourceAgent, req.targetAgent)
  for (const row of history.slice(0, LOOP_THRESHOLDS.historyWindow)) {
    if (row.targetAgent) addEdge(row.sourceAgent, row.targetAgent)
  }

  // DFS from each node looking for a back-edge to an ancestor of size ≥ 3.
  // White / Gray / Black coloring.
  const cyclePath = findCycle(edges)
  if (!cyclePath || cyclePath.length < 3) return null
  return {
    rule: 'loop_cycle',
    category: 'loop',
    points: POINTS.cycle,
    reason: `Directed cycle in call graph (${cyclePath.join(' → ')} → ${cyclePath[0]})`,
    evidence: cyclePath.join(' → '),
  }
}

function findCycle(edges: Map<string, Set<string>>): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const node of edges.keys()) color.set(node, WHITE)
  const stack: string[] = []

  function dfs(node: string): string[] | null {
    color.set(node, GRAY)
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) {
        // Cycle: slice stack from `next` to end
        const startIdx = stack.indexOf(next)
        return stack.slice(startIdx)
      }
      if (c === WHITE) {
        const found = dfs(next)
        if (found) return found
      }
    }
    color.set(node, BLACK)
    stack.pop()
    return null
  }

  for (const node of edges.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = dfs(node)
      if (found) return found
    }
  }
  return null
}

// =============================================================================
// 3. Burst — ≥ burstCount calls from the same source in burstWindowMs
// =============================================================================

function burst(
  ctx: RiskContext,
  req: RiskRequest,
  now: number,
): RiskFactor | null {
  const cutoff = now - LOOP_THRESHOLDS.burstWindowMs
  const rows = ctx.db
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(eq(requests.sourceAgent, req.sourceAgent), gte(requests.createdAt, cutoff)),
    )
    .all()
  const count = rows.length + 1 // include the in-flight call
  if (count < LOOP_THRESHOLDS.burstCount) return null
  return {
    rule: 'loop_burst',
    category: 'loop',
    points: POINTS.burst,
    reason: `${count} calls from ${req.sourceAgent} in last ${LOOP_THRESHOLDS.burstWindowMs / 1000}s`,
    evidence: `${count} calls / ${LOOP_THRESHOLDS.burstWindowMs / 1000}s`,
  }
}

// =============================================================================
// 4. Token budget — session cumulative tokens ≥ 80% of the configured limit
// =============================================================================

function tokenBudget(
  ctx: RiskContext,
  req: RiskRequest,
): RiskFactor | null {
  if (!req.sessionId) return null
  const row = ctx.db
    .select({ tokenCount: sessions.tokenCount })
    .from(sessions)
    .where(eq(sessions.id, req.sessionId))
    .get()
  if (!row) return null
  // #529 — Pull the limit + warning threshold from the policy engine
  // (per-call closure so policy.yaml reloads land mid-session). Hardcoded
  // fallback matches SessionManager's DEFAULT_TOKEN_LIMIT so deployments
  // that don't wire `sessionLimits` get the same behaviour as before this
  // PR. This rule is purely **advisory** — the actual halt happens in
  // SessionManager.recordTurn.
  const limits = ctx.sessionLimits?.()
  const limit = limits?.tokenLimit ?? 100_000
  const warnRatio = limits
    ? limits.tokenBudgetWarningPct / 100
    : LOOP_THRESHOLDS.tokenBudgetWarnRatio
  const used = row.tokenCount
  if (used < limit * warnRatio) return null
  const ratio = Math.min(100, Math.round((used / limit) * 100))
  return {
    rule: 'loop_token_budget',
    category: 'loop',
    points: POINTS.tokenBudget,
    reason: `Session burned ${ratio}% of the ${limit / 1000}K token budget (${used} tokens)`,
    evidence: `${used} / ${limit} tokens`,
  }
}

// =============================================================================
// Rule
// =============================================================================

export const loopDetectionRule: RiskRule = {
  name: 'loop_detection',
  category: 'loop',
  evaluate(req, ctx): RiskFactor[] {
    const factors: RiskFactor[] = []
    const now = Date.now()

    let history: readonly CallRow[] = []
    try {
      // Burst / pingpong / cycle all need recent rows. Pull once.
      history = loadHistory(ctx, now - LOOP_THRESHOLDS.burstWindowMs * 5)
    } catch {
      // Defensive: a query error must not crash the mediator.
      return factors
    }

    const pp = pingPong(history, req)
    if (pp) factors.push(pp)

    const cy = detectCycle(history, req)
    if (cy) factors.push(cy)

    try {
      const bu = burst(ctx, req, now)
      if (bu) factors.push(bu)
    } catch {
      // ignore
    }

    try {
      const tb = tokenBudget(ctx, req)
      if (tb) factors.push(tb)
    } catch {
      // ignore (sessions table may not exist in some test contexts)
    }

    return factors
  },
}
