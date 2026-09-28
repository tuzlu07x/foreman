import { eq } from 'drizzle-orm'
import type { ForemanDb } from '../db/client.js'
import { auditEvents, requests } from '../db/schema.js'
import { redactSecretsDeep } from './risk-rules/secret-patterns.js'
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
  type Unsubscribe,
} from './event-bus.js'

const FLUSH_INTERVAL_MS = 100
const FLUSH_MAX_BATCH = 50
/** Backoff cap between retries of a batch another process kept locked. */
const RETRY_MAX_DELAY_MS = 5_000
/** Timer retries after a lock error; after that, the next audit entry,
 *  `flush()` or `dispose()` tries again (nothing retries on its own forever). */
const RETRY_MAX_ATTEMPTS = 8

type RequestRow = typeof requests.$inferInsert
type AuditEventRow = typeof auditEvents.$inferInsert

type QueueEntry =
  | { kind: 'request'; row: RequestRow }
  | { kind: 'event'; row: AuditEventRow }
  | { kind: 'amend'; id: string; decision: RequestRow['decision']; decidedBy: string }

export interface AuditLoggerOptions {
  /** Override the 100ms timer (mostly for tests). */
  flushIntervalMs?: number
  /** Override the 50-entry batch cap (mostly for tests). */
  flushMaxBatch?: number
  /** Told when a batch could not be written because another process held
   *  the database past its busy timeout (#594). Defaults to a line on
   *  stderr; never stdout, which is mcp-stdio's JSON-RPC channel. */
  onError?: (message: string) => void
}

/** SQLITE_BUSY / SQLITE_LOCKED (and their extended codes): another
 *  connection held the lock. The transaction rolled back, so the batch can
 *  be written again unchanged. */
function isLockError(err: unknown): boolean {
  const code =
    err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : ''
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
}

function entries(n: number): string {
  return `${n} audit ${n === 1 ? 'entry' : 'entries'}`
}

function defaultOnError(message: string): void {
  process.stderr.write(`foreman: ${message}\n`)
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
  private readonly onError: (message: string) => void
  /** Consecutive flushes that failed on a lock held by another process. */
  private lockFailures = 0
  private disposed = false

  constructor(
    db: ForemanDb,
    bus: EventBus<ForemanEventMap> = defaultBus,
    options: AuditLoggerOptions = {},
  ) {
    this.db = db
    this.bus = bus
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS
    this.flushMaxBatch = options.flushMaxBatch ?? FLUSH_MAX_BATCH
    this.onError = options.onError ?? defaultOnError
    this.onBeforeExit = () => this.flushInBackground()
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

  /** Correct a request's recorded decision after the fact, e.g. a call the
   *  policy allowed that the MCP hub then withheld (#635). Queued behind the
   *  request's own row, so it always lands after the insert, and flushed
   *  at once so the log is right before the agent hears back. */
  amendDecision(requestId: string, decision: RequestRow['decision'], decidedBy: string): void {
    this.queue.push({ kind: 'amend', id: requestId, decision, decidedBy })
    this.flush()
  }

  /** Drain the queue immediately. Idempotent on an empty queue.
   *
   *  Throws when the write fails. If another process held the database
   *  past its busy timeout, the batch stays queued, in order, and is
   *  retried (#594): an audit row is only dropped from memory once it
   *  is on disk. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    try {
      this.db.transaction((tx) => {
        for (const entry of batch) {
          if (entry.kind === 'request') tx.insert(requests).values(entry.row).run()
          else if (entry.kind === 'amend') {
            tx.update(requests)
              .set({ decision: entry.decision, decidedBy: entry.decidedBy })
              .where(eq(requests.id, entry.id))
              .run()
          } else tx.insert(auditEvents).values(entry.row).run()
        }
      })
    } catch (err) {
      if (!isLockError(err)) throw err
      // The transaction rolled back: nothing of the batch was written.
      this.queue = batch.concat(this.queue)
      this.lockFailures++
      const retry = !this.disposed && this.lockFailures <= RETRY_MAX_ATTEMPTS
      if (retry) this.armTimer()
      this.onError(
        `audit log write failed (${err instanceof Error ? err.message : String(err)}); ` +
          (this.disposed
            ? `${entries(this.queue.length)} not written`
            : `${entries(this.queue.length)} kept, ` +
              (retry
                ? `retrying in ${this.retryDelayMs()} ms`
                : 'retrying with the next audit entry or on exit')),
      )
      throw err
    }
    if (this.lockFailures > 0) {
      this.lockFailures = 0
      this.onError(`audit log writes recovered (${entries(batch.length)} written)`)
    }
  }

  /** Pending entries waiting on the next flush. Mainly for tests. */
  pendingCount(): number {
    return this.queue.length
  }

  /** Unsubscribe from the bus, flush remaining entries, and detach from
   *  process exit. Throws if the final write fails; `pendingCount()` then
   *  says how many entries were not written. */
  dispose(): void {
    process.off('beforeExit', this.onBeforeExit)
    for (const off of this.subscriptions) off()
    this.subscriptions = []
    // Final: no retry outlives the logger.
    this.disposed = true
    this.flush()
  }

  private scheduleFlush(): void {
    // While another process holds the lock, a full batch waits for the
    // retry timer instead of blocking this process on every new entry.
    if (this.queue.length >= this.flushMaxBatch && this.lockFailures === 0) {
      this.flushInBackground()
      return
    }
    this.armTimer()
  }

  private armTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushInBackground()
    }, this.retryDelayMs())
    // Don't keep the event loop alive just for a pending flush.
    this.flushTimer.unref?.()
  }

  private retryDelayMs(): number {
    if (this.lockFailures === 0) return this.flushIntervalMs
    return Math.min(this.flushIntervalMs * 2 ** this.lockFailures, RETRY_MAX_DELAY_MS)
  }

  /** A flush nobody waits on (timer, batch cap, process exit). A lock
   *  error was already reported and the batch kept by flush(); throwing it
   *  from a timer would crash the process (#594: the agent's MCP server
   *  died and the batch was lost). Any other error still throws. */
  private flushInBackground(): void {
    try {
      this.flush()
    } catch (err) {
      if (!isLockError(err)) throw err
    }
  }

  private subscribe(): void {
    this.subscriptions.push(
      this.bus.on('request:decided', (e) => {
        this.logRequest({
          id: e.requestId,
          sourceAgent: e.sourceAgent,
          targetAgent: e.targetAgent ?? null,
          targetTool: e.targetTool ?? null,
          // Credential-shaped values are masked before they reach the
          // audit log / FTS index; paths and commands stay searchable.
          args: JSON.stringify(redactSecretsDeep(e.args)),
          riskScore: e.riskScore,
          riskReasons: JSON.stringify(e.riskReasons),
          riskFactors:
            e.riskFactors.length > 0 ? JSON.stringify(e.riskFactors) : null,
          riskBucket: e.riskBucket,
          llmVerification: e.llmVerification
            ? JSON.stringify(e.llmVerification)
            : null,
          securityReport: e.securityReport
            ? JSON.stringify(e.securityReport)
            : null,
          decision: e.decision,
          decidedBy: e.decidedBy,
          result: e.result === undefined ? null : JSON.stringify(e.result),
          durationMs: e.durationMs,
          createdAt: e.createdAt,
          decidedAt: e.decidedAt,
          // #301 — persist the agent-to-agent flow tracking links so
          // `foreman log tail --session <id>` + the upcoming TUI session-
          // tree view can render the chain.
          parentRequestId: e.parentRequestId ?? null,
          sessionId: e.sessionId ?? null,
        })
      }),
      this.bus.on('agent:registered', (e) =>
        this.logEvent('agent_registered', e),
      ),
      this.bus.on('policy:changed', (e) => this.logEvent('policy_changed', e)),
      this.bus.on('session:halted', (e) => this.logEvent('session_halted', e)),
      // #435 — Persist crash events so the activity digest can list
      // crashes in the last N minutes. Bus-only emission would lose
      // them once the TUI clears its in-memory banner.
      this.bus.on('agent:daemon-crashed', (e) =>
        this.logEvent('agent_daemon_crashed', e),
      ),
    )
  }
}
