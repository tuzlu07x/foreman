/**
 * Mediated codex task runner (#552 PR 7).
 *
 * Composes the spawn helper (PR 4) + bridge + connector into a single
 * end-to-end task lifecycle: spawn codex exec-server, initialize, start
 * a thread, start a turn with the user's prompt, listen for the turn-
 * completed notification, shut down cleanly.
 *
 * Every approval request codex emits during the turn flows through the
 * mediator. Low-risk → auto-allow → codex proceeds. High-risk → mediator
 * surfaces the approval in chat, blocks the JSON-RPC reply until the
 * operator decides, then unblocks codex with the resolved decision.
 *
 * This module is the closest a Foreman call site gets to "execute this
 * task on codex with full mediation" without touching the spawn engine.
 * Wiring it into `agent-spawn.ts` (so `foreman write codex …` routes
 * through here automatically) is a separate, future change that needs
 * careful surgery on the existing spawn lifecycle (PID files, audit
 * rows, timeout supervision); this PR ships the runner so call sites
 * that want mediated execution can opt in today.
 *
 * Tests drive the runner with the same in-memory fake-spawn harness
 * used in PR 4. A gated live-codex E2E test confirms the wire shapes
 * against a real `codex exec-server` process when CODEX_E2E=1 is set.
 */

import {
  spawnCodexMediated,
  type CodexSpawnLike,
  type SpawnCodexMediatedOptions,
} from './codex-mediated-spawn.js'
import type { MediatorLike } from './codex-mediator-connector.js'

export interface RunMediatedCodexTaskOptions {
  /** Mediator (or test double) — runs risk + approval per request. */
  mediator: MediatorLike
  /** Agent id recorded on every audit row (typically 'codex'). */
  sourceAgent: string
  /** The user's prompt — fed verbatim to codex as the turn input. */
  prompt: string
  /** Working directory codex inherits + the directory passed to
   *  `thread/start`. Defaults to `process.cwd()`. */
  cwd?: string
  /** Optional spawn override for tests. */
  spawnImpl?: CodexSpawnLike
  /** Argv override — defaults to `codex exec-server --listen stdio`. */
  argv?: SpawnCodexMediatedOptions['argv']
  /** Hard ceiling on turn duration. Default 10 minutes, matching the
   *  existing agent-spawn engine's default. */
  timeoutMs?: number
  /** Env overrides forwarded to the codex child process. */
  env?: NodeJS.ProcessEnv
}

/** Stage at which a mediated codex task can fail. Surfaces on
 *  `MediatedTaskOutcome` so incident triage knows where to look. */
export type MediatedFailureStage =
  | 'spawn'
  | 'initialize'
  | 'thread'
  | 'turn'
  | 'timeout'
  | 'transport'

export type MediatedTaskOutcome =
  | {
      ok: true
      /** turn/completed status — typically 'completed' but codex may
       *  surface 'interrupted' / 'failed' / 'cancelled'. Caller decides
       *  how to react. */
      status: string
      threadId: string
      turnId: string | null
    }
  | {
      ok: false
      stage: MediatedFailureStage
      error: string
      threadId?: string
      turnId?: string | null
    }

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Run a single codex turn end-to-end with Foreman mediation on every
 * outbound action. Resolves once codex emits `turn/completed` for the
 * turn we started, or once the timeout fires.
 *
 * Lifecycle:
 *   1. Spawn codex exec-server with stdio piped.
 *   2. initialize (the spawn helper does this; await `session.ready`).
 *   3. thread/start → get a threadId.
 *   4. turn/start with the prompt → optionally get a turnId.
 *   5. Wait for the matching turn/completed notification.
 *   6. shutdown — SIGTERM the child + stop the bridge.
 *
 * All approval requests codex emits during step 5 route through the
 * connector → mediator → adapter chain without further action from
 * this module.
 */
export async function runMediatedCodexTask(
  opts: RunMediatedCodexTaskOptions,
): Promise<MediatedTaskOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let activeTurnId: string | null = null

  // The completion promise resolves when codex emits a `turn/completed`
  // (or `turn/closed` for older builds) matching `activeTurnId`, or
  // rejects on transport error. The `stage` member rides along on a
  // tagged Error so the catch block can return a structured outcome
  // instead of a bare error string.
  type StagedError = Error & { stage?: MediatedFailureStage }
  let resolveCompletion!: (status: string) => void
  let rejectCompletion!: (err: StagedError) => void
  const completion = new Promise<string>((res, rej) => {
    resolveCompletion = res
    rejectCompletion = rej
  })

  const session = spawnCodexMediated({
    mediator: opts.mediator,
    sourceAgent: opts.sourceAgent,
    cwd: opts.cwd,
    env: opts.env,
    spawnImpl: opts.spawnImpl,
    argv: opts.argv,
    hooks: {
      onNotification(method, params) {
        // Codex emits the turn-finalisation event as a notification on
        // a method whose exact name has shifted across versions (we've
        // seen `turn/completed`, `turn/closed`, `thread/turn/completed`).
        // Treat any *completion-shaped* method whose params carry our
        // active turnId as the end signal so the runner survives a
        // schema bump without code changes.
        if (!isCompletionMethod(method)) return
        const p = params as { turnId?: string; status?: string }
        if (activeTurnId && p.turnId && p.turnId !== activeTurnId) return
        resolveCompletion(p.status ?? 'completed')
      },
      onTransportError(err) {
        const e = err as StagedError
        e.stage = 'transport'
        rejectCompletion(e)
      },
    },
  })

  const timeoutHandle = setTimeout(() => {
    const e = new Error(
      `mediated codex task timed out after ${timeoutMs}ms`,
    ) as StagedError
    e.stage = 'timeout'
    rejectCompletion(e)
  }, timeoutMs)

  let threadId: string | undefined
  let stage: 'initialize' | 'thread' | 'turn' = 'initialize'

  try {
    await session.ready

    stage = 'thread'
    const threadResp = (await session.bridge.request('thread/start', {
      cwd: opts.cwd ?? process.cwd(),
    })) as { threadId?: string; thread?: { id?: string } }
    threadId = threadResp.threadId ?? threadResp.thread?.id
    if (!threadId) {
      throw new Error('thread/start response did not include a threadId')
    }

    stage = 'turn'
    const turnResp = (await session.bridge.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: opts.prompt }],
    })) as {
      turnId?: string
      turn?: { id?: string; turnId?: string }
    }
    activeTurnId =
      turnResp.turnId ?? turnResp.turn?.id ?? turnResp.turn?.turnId ?? null

    const status = await completion
    return { ok: true, status, threadId, turnId: activeTurnId }
  } catch (err) {
    const e = err as StagedError
    const failureStage: MediatedFailureStage = e.stage ?? stage
    return {
      ok: false,
      stage: failureStage,
      error: err instanceof Error ? err.message : String(err),
      threadId,
      turnId: activeTurnId,
    }
  } finally {
    clearTimeout(timeoutHandle)
    await session.shutdown()
  }
}

/** Method names codex has used for the turn-finalisation notification
 *  across recent versions. */
function isCompletionMethod(method: string): boolean {
  return (
    method === 'turn/completed' ||
    method === 'turn/closed' ||
    method === 'thread/turn/completed'
  )
}
