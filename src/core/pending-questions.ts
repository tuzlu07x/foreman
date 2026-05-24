import { and, eq, gte } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ForemanDb } from '../db/client.js'
import { pendingQuestions } from '../db/schema.js'
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from './event-bus.js'

// =============================================================================
// PendingQuestionsService (#528)
// =============================================================================
//
// Owns the `pending_questions` table — the cross-process queue that backs
// the `ask_user_with_options` MCP tool. The agent's tool call lives in
// the mcp-stdio process; the chat listener that resolves answers lives in
// `foreman start`. SQLite is the shared queue.
//
// API mirrors the approval pattern (DbApprovalService): create-then-poll
// on the writer side, mark-then-emit on the reader side. The bus event
// is fired as a convenience so an in-process bridge can react without
// polling.

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 200

export interface AskQuestionInput {
  sourceAgent: string
  sessionId?: string
  question: string
  context?: string
  options: Array<{
    id: string
    label: string
    payload?: Record<string, unknown>
  }>
  allowFreeText?: boolean
  timeoutMs?: number
}

export interface QuestionResolution {
  questionId: string
  outcome: 'answered' | 'timeout' | 'abandoned'
  chosenOptionId?: string
  freeText?: string
  /** Label of the chosen option (resolved on the writer side so the agent
   *  doesn't have to re-look-up). Null on timeout / abandoned / free-text. */
  label?: string
  /** Echoed payload from the chosen option's `payload` field. Null when
   *  the user typed free text or no option was picked. */
  payload?: Record<string, unknown>
  answeredAt: number
  answeredBy?: string
}

export interface AnswerInput {
  questionId: string
  chosenOptionId?: string
  freeText?: string
  answeredBy?: string
}

export interface PendingQuestionsOptions {
  bus?: EventBus<ForemanEventMap>
  pollIntervalMs?: number
}

export class PendingQuestionsService {
  private readonly bus: EventBus<ForemanEventMap>
  private readonly pollIntervalMs: number

  constructor(
    private readonly db: ForemanDb,
    opts: PendingQuestionsOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  /** Create a pending question, emit `question:asked`, and block until
   *  the row is resolved or the deadline elapses. The polling cadence
   *  mirrors DbApprovalService so a single notification bridge can
   *  service approvals + questions with the same heartbeat. */
  async ask(input: AskQuestionInput): Promise<QuestionResolution> {
    const questionId = ulid()
    const requestedAt = Date.now()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadlineMs = requestedAt + timeoutMs
    const allowFreeText = input.allowFreeText ?? true

    this.db
      .insert(pendingQuestions)
      .values({
        id: questionId,
        sourceAgent: input.sourceAgent,
        sessionId: input.sessionId ?? null,
        question: input.question,
        context: input.context ?? null,
        optionsJson: JSON.stringify(input.options),
        allowFreeText: allowFreeText ? 1 : 0,
        status: 'pending',
        requestedAt,
        deadlineMs,
      })
      .run()

    this.bus.emit('question:asked', {
      questionId,
      sourceAgent: input.sourceAgent,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      question: input.question,
      ...(input.context !== undefined ? { context: input.context } : {}),
      options: input.options,
      allowFreeText,
      deadlineMs,
      requestedAt,
    })

    while (Date.now() < deadlineMs) {
      const row = this.db
        .select()
        .from(pendingQuestions)
        .where(eq(pendingQuestions.id, questionId))
        .get()
      if (row && row.status !== 'pending') {
        return this.rowToResolution(row, input.options)
      }
      await sleep(this.pollIntervalMs)
    }

    // Timeout — flip the row to 'timeout' so the chat listener stops
    // seeing it as live.
    this.db
      .update(pendingQuestions)
      .set({
        status: 'timeout',
        answeredAt: Date.now(),
      })
      .where(
        and(
          eq(pendingQuestions.id, questionId),
          eq(pendingQuestions.status, 'pending'),
        ),
      )
      .run()
    this.bus.emit('question:answered', {
      questionId,
      outcome: 'timeout',
      answeredAt: Date.now(),
    })
    return {
      questionId,
      outcome: 'timeout',
      answeredAt: Date.now(),
    }
  }

  /** Resolve a pending question with the user's pick. Called by the
   *  `submit_user_answer` MCP tool when the agent relays a button tap
   *  or a free-text reply. Returns ok=false when the id is unknown or
   *  the row is no longer pending so the caller can surface a
   *  user-readable error. */
  answer(input: AnswerInput): { ok: boolean; error?: string; resolution?: QuestionResolution } {
    const row = this.db
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.id, input.questionId))
      .get()
    if (!row) {
      return { ok: false, error: `question ${input.questionId} not found` }
    }
    if (row.status !== 'pending') {
      return {
        ok: false,
        error: `question ${input.questionId} already ${row.status}`,
      }
    }
    const allowFreeText = row.allowFreeText === 1
    const hasOption =
      typeof input.chosenOptionId === 'string' && input.chosenOptionId.length > 0
    const hasFreeText =
      typeof input.freeText === 'string' && input.freeText.length > 0
    if (!hasOption && !hasFreeText) {
      return {
        ok: false,
        error: 'answer requires either chosen_option_id or free_text',
      }
    }
    if (hasFreeText && !allowFreeText) {
      return {
        ok: false,
        error: `question ${input.questionId} does not allow free-text answers`,
      }
    }
    const options = safeParseOptions(row.optionsJson)
    if (hasOption && !options.find((o) => o.id === input.chosenOptionId)) {
      return {
        ok: false,
        error: `option "${input.chosenOptionId}" not offered for question ${input.questionId}`,
      }
    }
    const answeredAt = Date.now()
    this.db
      .update(pendingQuestions)
      .set({
        status: 'answered',
        chosenOptionId: hasOption ? input.chosenOptionId! : null,
        freeText: hasFreeText ? input.freeText! : null,
        answeredAt,
        answeredBy: input.answeredBy ?? null,
      })
      .where(eq(pendingQuestions.id, input.questionId))
      .run()
    const resolution = this.rowToResolution(
      {
        ...row,
        status: 'answered',
        chosenOptionId: hasOption ? input.chosenOptionId! : null,
        freeText: hasFreeText ? input.freeText! : null,
        answeredAt,
        answeredBy: input.answeredBy ?? null,
      },
      options,
    )
    this.bus.emit('question:answered', {
      questionId: input.questionId,
      outcome: 'answered',
      ...(resolution.chosenOptionId !== undefined
        ? { chosenOptionId: resolution.chosenOptionId }
        : {}),
      ...(resolution.freeText !== undefined
        ? { freeText: resolution.freeText }
        : {}),
      ...(resolution.answeredBy !== undefined
        ? { answeredBy: resolution.answeredBy }
        : {}),
      answeredAt,
    })
    return { ok: true, resolution }
  }

  /** Mark a pending question as abandoned — user explicitly dismissed
   *  it ("/cancel" or a dismiss button). Returns false when the row
   *  isn't found / no longer pending. */
  abandon(questionId: string, abandonedBy?: string): boolean {
    const row = this.db
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.id, questionId))
      .get()
    if (!row || row.status !== 'pending') return false
    const answeredAt = Date.now()
    this.db
      .update(pendingQuestions)
      .set({
        status: 'abandoned',
        answeredAt,
        answeredBy: abandonedBy ?? null,
      })
      .where(eq(pendingQuestions.id, questionId))
      .run()
    this.bus.emit('question:answered', {
      questionId,
      outcome: 'abandoned',
      ...(abandonedBy !== undefined ? { answeredBy: abandonedBy } : {}),
      answeredAt,
    })
    return true
  }

  /** Active (pending) questions older than `staleMs` get auto-abandoned
   *  with reason "timeout" so a session that the user walked away from
   *  doesn't sit forever. Returns the number of rows expired. Called
   *  by the bridge's periodic scan. */
  expireStale(staleMs: number, nowMs: number = Date.now()): number {
    const cutoff = nowMs - staleMs
    const stale = this.db
      .select()
      .from(pendingQuestions)
      .where(
        and(
          eq(pendingQuestions.status, 'pending'),
          // The deadline column is absolute — anything past it is stale.
          // Use a manual filter post-fetch because Drizzle's gte returns
          // rows where deadline >= cutoff but we want deadline <= now.
        ),
      )
      .all()
      .filter((row) => row.deadlineMs <= nowMs)
    void cutoff
    void gte
    for (const row of stale) {
      this.db
        .update(pendingQuestions)
        .set({ status: 'timeout', answeredAt: nowMs })
        .where(eq(pendingQuestions.id, row.id))
        .run()
      this.bus.emit('question:answered', {
        questionId: row.id,
        outcome: 'timeout',
        answeredAt: nowMs,
      })
    }
    return stale.length
  }

  /** Fetch one pending question by id (used by the notification bridge
   *  + agent SOUL test paths that want the raw row). */
  get(questionId: string): (typeof pendingQuestions.$inferSelect) | null {
    return (
      this.db
        .select()
        .from(pendingQuestions)
        .where(eq(pendingQuestions.id, questionId))
        .get() ?? null
    )
  }

  /** List active (pending) questions, newest first. Used by `foreman
   *  questions list` (future CLI) + integration tests. */
  pending(limit = 16): (typeof pendingQuestions.$inferSelect)[] {
    return this.db
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.status, 'pending'))
      .all()
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .slice(0, limit)
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private rowToResolution(
    row: typeof pendingQuestions.$inferSelect,
    options: AskQuestionInput['options'],
  ): QuestionResolution {
    const outcome: 'answered' | 'timeout' | 'abandoned' =
      row.status === 'answered'
        ? 'answered'
        : row.status === 'timeout'
          ? 'timeout'
          : 'abandoned'
    const chosen = row.chosenOptionId
      ? options.find((o) => o.id === row.chosenOptionId)
      : undefined
    return {
      questionId: row.id,
      outcome,
      ...(row.chosenOptionId ? { chosenOptionId: row.chosenOptionId } : {}),
      ...(row.freeText ? { freeText: row.freeText } : {}),
      ...(chosen?.label ? { label: chosen.label } : {}),
      ...(chosen?.payload ? { payload: chosen.payload } : {}),
      answeredAt: row.answeredAt ?? Date.now(),
      ...(row.answeredBy ? { answeredBy: row.answeredBy } : {}),
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeParseOptions(text: string): AskQuestionInput['options'] {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed as AskQuestionInput['options']
  } catch {
    return []
  }
}
