import type { ForemanDb } from '../db/client.js'
import { auditEvents, requests } from '../db/schema.js'
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
  type Unsubscribe,
} from './event-bus.js'

const FLUSH_INTERVAL_MS = 100
const FLUSH_MAX_BATCH = 50

type RequestRow = typeof requests.$inferInsert
type AuditEventRow = typeof auditEvents.$inferInsert

type QueueEntry =
  | { kind: 'request'; row: RequestRow }
  | { kind: 'event'; row: AuditEventRow }

export interface AuditLoggerOptions {
  /** Override the 100ms timer (mostly for tests). */
  flushIntervalMs?: number
  /** Override the 50-entry batch cap (mostly for tests). */
  flushMaxBatch?: number
}

/**
 * Writes audit data to SQLite in 100ms / 50-entry batches inside a single
 * transaction per flush. Auto-subscribes to the bus on construction; call
 * `dispose()` to unsubscribe (and flush) — pair it with the lifecycle of
 * whatever instantiated the logger.
 *
 * Note on FTS5: `requests_fts` is kept in sync by triggers (see migration
 * `0001_fts5_requests.sql`), so writes here only touch `requests`.
 */
export class AuditLogger {
  private readonly db: ForemanDb
  private readonly bus: EventBus<ForemanEventMap>
  private readonly flushIntervalMs: number
  private readonly flushMaxBatch: number
  private queue: QueueEntry[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private subscriptions: Unsubscribe[] = []
  private readonly onBeforeExit: () => void

  constructor(
    db: ForemanDb,
    bus: EventBus<ForemanEventMap> = defaultBus,
    options: AuditLoggerOptions = {},
  ) {
    this.db = db
    this.bus = bus
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS
    this.flushMaxBatch = options.flushMaxBatch ?? FLUSH_MAX_BATCH
    this.onBeforeExit = () => this.flush()
    this.subscribe()
    process.once('beforeExit', this.onBeforeExit)
  }

  logRequest(row: RequestRow): void {
    this.queue.push({ kind: 'request', row })
    this.scheduleFlush()
  }

  logEvent(eventType: string, payload: unknown): void {
    this.queue.push({
      kind: 'event',
      row: {
        eventType,
        payload: JSON.stringify(payload),
        createdAt: Date.now(),
      },
    })
    this.scheduleFlush()
  }

  /** Drain the queue immediately. Idempotent on an empty queue. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    this.db.transaction((tx) => {
      for (const entry of batch) {
        if (entry.kind === 'request') tx.insert(requests).values(entry.row).run()
        else tx.insert(auditEvents).values(entry.row).run()
      }
    })
  }

  /** Pending entries waiting on the next flush. Mainly for tests. */
  pendingCount(): number {
    return this.queue.length
  }

  /** Unsubscribe from the bus, flush remaining entries, and detach from process exit. */
  dispose(): void {
    process.off('beforeExit', this.onBeforeExit)
    for (const off of this.subscriptions) off()
    this.subscriptions = []
    this.flush()
  }

  private scheduleFlush(): void {
    if (this.queue.length >= this.flushMaxBatch) {
      this.flush()
      return
    }
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.flushIntervalMs)
    // Don't keep the event loop alive just for a pending flush.
    this.flushTimer.unref?.()
  }

  private subscribe(): void {
    this.subscriptions.push(
      this.bus.on('request:decided', (e) => {
        this.logRequest({
          id: e.requestId,
          sourceAgent: e.sourceAgent,
          targetAgent: e.targetAgent ?? null,
          targetTool: e.targetTool ?? null,
          args: JSON.stringify(e.args),
          riskScore: e.riskScore,
          riskReasons: JSON.stringify(e.riskReasons),
          riskFactors:
            e.riskFactors.length > 0 ? JSON.stringify(e.riskFactors) : null,
          riskBucket: e.riskBucket,
          llmVerification: e.llmVerification
            ? JSON.stringify(e.llmVerification)
            : null,
          decision: e.decision,
          decidedBy: e.decidedBy,
          result: e.result === undefined ? null : JSON.stringify(e.result),
          durationMs: e.durationMs,
          createdAt: e.createdAt,
          decidedAt: e.decidedAt,
        })
      }),
      this.bus.on('agent:registered', (e) =>
        this.logEvent('agent_registered', e),
      ),
      this.bus.on('policy:changed', (e) => this.logEvent('policy_changed', e)),
      this.bus.on('session:halted', (e) => this.logEvent('session_halted', e)),
    )
  }
}
