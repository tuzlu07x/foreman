/**
 * Telegram getUpdates long-poller (#445 PR 2).
 *
 * Used by the agent-wrap process to receive user messages from
 * Telegram and forward them to a chat-only daemon agent's input
 * stream. Before #406, Foreman polled Telegram directly + spawned
 * the agent as a child. Then #406 / #426 moved polling INTO each
 * chat-capable agent because Telegram only allows one `getUpdates`
 * consumer per bot. The wrap mode in #445 reverses that decision
 * for chat-only daemon agents: Foreman polls again, but only ONE
 * wrap polls per channel (inheriting #426's primary-chat-agent
 * semantics), so the conflict is structurally avoided.
 *
 * Surgical scope:
 *   - Long-polling loop with offset tracking.
 *   - Owner filter (drops updates not from the registered owner
 *     chat — same filter every chat-capable agent enforces today).
 *   - `onUpdate(rawUpdate)` callback per accepted update.
 *   - No directive injection (#445 PR 3 layers that on).
 *   - No process spawning (#445 PR 2 — AgentWrap class — layers
 *     that on).
 *
 * Testability:
 *   - `fetchImpl` defaults to `globalThis.fetch` but can be replaced
 *     with a fake that returns pre-canned `getUpdates` responses.
 *   - `setTimeoutImpl` for stubbing the delay between failures.
 *   - No singleton state — every poller is independent so per-test
 *     instances don't bleed.
 */

import { Buffer } from 'node:buffer'

export interface TelegramUpdate {
  update_id: number
  message?: {
    from?: { id?: number; is_bot?: boolean }
    chat?: { id?: number; type?: string }
    text?: string
    [key: string]: unknown
  }
  /** Telegram Updates carry many other fields (callback_query, edited_message,
   *  …). The poller forwards them verbatim — only `update_id` is required
   *  here for offset bookkeeping, and the owner filter inspects `message
   *  .from.id`. */
  [key: string]: unknown
}

interface GetUpdatesResponse {
  ok: boolean
  result?: TelegramUpdate[]
  description?: string
}

/** Tiny fetch shim — accepts only what the poller actually uses so a test
 *  fake doesn't have to implement the full DOM Response. */
export type PollerFetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface TelegramPollerOptions {
  /** Bot token used to authenticate against api.telegram.org. */
  botToken: string
  /** Telegram chat id of the registered owner. Updates whose
   *  `message.from.id` does not match are silently dropped (matches
   *  the filter every chat-capable agent enforces today). */
  ownerChatId: number
  /** Callback fired for every accepted update. May be sync or async;
   *  the poller awaits async callbacks before requesting the next
   *  batch so back-pressure is real (the child agent processes one
   *  update at a time). */
  onUpdate(update: TelegramUpdate): void | Promise<void>
  /** Long-poll timeout in seconds (sent to Telegram's getUpdates).
   *  Defaults to 25 — Telegram's recommended balance between
   *  responsiveness and HTTP overhead. */
  longPollSeconds?: number
  /** Delay (ms) between retries after a transport / 5xx failure.
   *  Defaults to 2000. */
  retryDelayMs?: number
  /** Optional transport override (tests). */
  fetchImpl?: PollerFetchLike
  /** Optional timer override (tests). */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown
  /** Optional logger for transport-level errors. Defaults to a
   *  no-op so unit tests don't need to silence it. */
  onError?(err: Error): void
}

export class TelegramPoller {
  private offset = 0
  private running = false
  private aborter: AbortController | null = null

  constructor(private readonly opts: TelegramPollerOptions) {}

  /** Start polling. Idempotent — calling twice on the same instance is
   *  a no-op (returns the same active loop). Resolves once the loop is
   *  underway, NOT when polling ends. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** Stop polling. Aborts any in-flight getUpdates call so the next
   *  loop iteration sees the stopped flag and exits. Idempotent. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.aborter?.abort()
    this.aborter = null
  }

  /** Reset the offset cursor. Mostly useful in tests; production
   *  callers should never need this. */
  resetOffset(): void {
    this.offset = 0
  }

  private async loop(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? (globalThis.fetch as unknown as PollerFetchLike)
    const setTimeoutImpl =
      this.opts.setTimeoutImpl ??
      ((cb: () => void, ms: number) => setTimeout(cb, ms))
    const longPollSeconds = this.opts.longPollSeconds ?? 25
    const retryDelayMs = this.opts.retryDelayMs ?? 2000

    while (this.running) {
      const aborter = new AbortController()
      this.aborter = aborter
      try {
        const url = `https://api.telegram.org/bot${this.opts.botToken}/getUpdates?offset=${this.offset}&timeout=${longPollSeconds}`
        const res = await fetchImpl(url, { method: 'GET', signal: aborter.signal })
        if (!res.ok) {
          // 4xx — fatal token / permission problem; stop polling and
          // surface so the wrap process can decide to exit.
          if (res.status >= 400 && res.status < 500) {
            const body = await res.text()
            this.opts.onError?.(
              new Error(`getUpdates ${res.status}: ${body.slice(0, 200)}`),
            )
            this.running = false
            break
          }
          // 5xx — transient; surface for observability + back off + retry.
          this.opts.onError?.(
            new Error(`getUpdates ${res.status} (transient, retrying)`),
          )
          await this.delay(setTimeoutImpl, retryDelayMs)
          continue
        }
        const body = (await res.json()) as GetUpdatesResponse
        if (!body.ok) {
          this.opts.onError?.(
            new Error(`getUpdates not-ok: ${body.description ?? 'no description'}`),
          )
          await this.delay(setTimeoutImpl, retryDelayMs)
          continue
        }
        const updates = body.result ?? []
        for (const update of updates) {
          this.offset = update.update_id + 1
          // Owner filter — drop messages from any chat / user other
          // than the registered owner. Mirrors the filter every
          // chat-capable agent enforces today; the agent process
          // would discard non-owner messages anyway, but doing it at
          // the wrap layer saves a child write + the agent's filter
          // pass.
          if (!this.passesOwnerFilter(update)) continue
          try {
            await this.opts.onUpdate(update)
          } catch (cbErr) {
            this.opts.onError?.(
              cbErr instanceof Error ? cbErr : new Error(String(cbErr)),
            )
          }
        }
      } catch (err) {
        // AbortError from stop() — exit cleanly.
        if ((err as { name?: string }).name === 'AbortError') break
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
        await this.delay(setTimeoutImpl, retryDelayMs)
      } finally {
        this.aborter = null
      }
    }
  }

  private passesOwnerFilter(update: TelegramUpdate): boolean {
    const fromId = update.message?.from?.id
    if (typeof fromId !== 'number') return false
    return fromId === this.opts.ownerChatId
  }

  private delay(
    setTimeoutImpl: NonNullable<TelegramPollerOptions['setTimeoutImpl']>,
    ms: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeoutImpl(() => resolve(), ms)
    })
  }
}

/** Helper — serialize a Telegram update as a newline-delimited JSON
 *  frame for stdin_jsonl-protocol agents. Used by AgentWrap (PR 2) and
 *  the directive-injection path (PR 3). */
export function serializeUpdateAsJsonl(update: TelegramUpdate): Buffer {
  return Buffer.from(JSON.stringify(update) + '\n', 'utf8')
}
