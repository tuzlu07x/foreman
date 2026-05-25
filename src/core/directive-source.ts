/**
 * Directive source — control_commands queue poller for `foreman agent-wrap`
 * (#445 PR 3).
 *
 * Polls the #440 `control_commands` table for `command='write'` rows
 * targeted at a specific agent, drains them in FIFO order, fires
 * `onDirective` per row, and marks each row as applied or failed.
 *
 * The polling cadence (default 1000 ms) matches the existing
 * `foreman start` drain loop's behaviour so the user-perceived latency
 * is identical regardless of which process picks the row up. PR 5
 * coordinates the two drain paths so the same row isn't processed
 * twice (foreman start skips wrap-managed agents); for PR 3 we don't
 * add that coordination yet — running both processes against the same
 * registered chat-only daemon agent during the migration window is an
 * acceptable transition cost.
 *
 * Args parsing for the `write` command (per src/cli/write-cli.ts):
 *   - `args` is a JSON-stringified array
 *   - args[0] = target agent id
 *   - args[1] = directive body (string)
 *
 * Failure rows (marked `failed`) carry the renderer / write error so
 * `foreman log` can show the operator what went wrong.
 */

import type { ControlChannel } from './control-channel.js'
import type { ControlCommand } from '../db/schema.js'

export interface DirectiveSourceOptions {
  /** ControlChannel handle used to query / mark control_commands rows. */
  channel: ControlChannel
  /** Agent id this source drains directives for. Rows whose
   *  `args[0]` does NOT match this id are ignored — the wrap doesn't
   *  speak for other agents. */
  agentId: string
  /** Fired for every claimed write directive. The handler MUST return
   *  a promise that resolves with `{ ok: true }` on successful
   *  injection (the source marks the row applied) or
   *  `{ ok: false, error }` on failure (the source marks it failed
   *  with the error text so the operator can see it via
   *  `foreman log`). */
  onDirective(directive: { id: number; body: string }): Promise<
    | { ok: true }
    | { ok: false; error: string }
  >
  /** Polling interval in ms. Defaults to 1000 — matches foreman start. */
  pollIntervalMs?: number
  /** Optional timer override (tests). */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
  /** Optional diagnostic sink. */
  onError?(err: Error): void
}

export class DirectiveSource {
  private timerHandle: unknown = null
  private running = false
  /** In-flight drain promise. Re-entrant calls await this instead of
   *  starting a second drain (which would race for the same rows
   *  between `pending()` and `markApplied()`). */
  private currentDrain: Promise<void> | null = null

  constructor(private readonly opts: DirectiveSourceOptions) {}

  /** Begin periodic polling. Idempotent. Tests that want to drive
   *  drains deterministically can skip `start()` entirely and call
   *  `drainOnce()` directly — the drain code path does NOT require
   *  the source to be running. */
  start(): void {
    if (this.running) return
    this.running = true
    const interval = this.opts.pollIntervalMs ?? 1000
    const setIntervalFn =
      this.opts.setIntervalImpl ??
      ((cb: () => void, ms: number) => setInterval(cb, ms))
    this.timerHandle = setIntervalFn(() => {
      void this.drainOnce()
    }, interval)
  }

  /** Stop periodic polling. Any in-flight drain completes naturally.
   *  Idempotent. */
  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.timerHandle !== null) {
      const clearFn =
        this.opts.clearIntervalImpl ??
        ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
      clearFn(this.timerHandle)
      this.timerHandle = null
    }
  }

  /** Drain pending write directives for this agent once. Re-entrant
   *  callers await the in-flight drain rather than starting a second
   *  one (avoids the pending/markApplied race). Public so tests can
   *  drive deterministic ticks. */
  drainOnce(): Promise<void> {
    if (this.currentDrain) return this.currentDrain
    const drain = (async () => {
      try {
        const rows: ControlCommand[] = this.opts.channel.pending(32)
        for (const row of rows) {
          if (row.command !== 'write') continue
          const parsed = parseWriteArgs(row.args)
          if (!parsed || parsed.agentId !== this.opts.agentId) continue
          try {
            const result = await this.opts.onDirective({
              id: row.id,
              body: parsed.body,
            })
            if (result.ok) {
              this.opts.channel.markApplied(row.id)
            } else {
              this.opts.channel.markFailed(row.id, result.error)
              this.opts.onError?.(
                new Error(`directive ${row.id} failed: ${result.error}`),
              )
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            this.opts.channel.markFailed(row.id, message)
            this.opts.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            )
          }
        }
      } finally {
        this.currentDrain = null
      }
    })()
    this.currentDrain = drain
    return drain
  }
}

/** Parse the JSON-stringified args column from a `write` control_command
 *  row. Returns null when the row is malformed so the drain can skip
 *  it without crashing the whole loop. */
export function parseWriteArgs(
  argsJson: string,
): { agentId: string; body: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const [agentId, body] = parsed
  if (typeof agentId !== 'string' || typeof body !== 'string') return null
  if (agentId.length === 0) return null
  return { agentId, body }
}
