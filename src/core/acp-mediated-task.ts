/**
 * Mediated task runner for ACP-mode agents.
 *
 * The ACP-side counterpart of `codex-mediated-task.ts`. Composes
 * `spawnAcpMediated` + `wireAcpBridgeToMediator` into a single
 * end-to-end task lifecycle for chat-only daemon agents that speak
 * ACP (Hermes / OpenClaw / ZeroClaw):
 *
 *   spawn → initialize → session/new → session/prompt →
 *     (mid-prompt approvals route through mediator) →
 *     session/prompt resolves with the agent's final reply →
 *     shutdown
 *
 * Differences vs `runMediatedCodexTask`:
 *
 *   - Codex's `turn/start` returns immediately with a Turn object;
 *     completion is a separate `turn/completed` notification we wait
 *     for. ACP's `session/prompt` is request-shaped — its JSON-RPC
 *     response IS the completion signal, with `session/update`
 *     notifications streaming progress during the await. That makes
 *     the ACP runner structurally simpler: just `await prompt`.
 *
 *   - Init params: `{ protocolVersion, clientCapabilities }` instead
 *     of `{ clientInfo }`.
 *
 *   - Per-prompt session id: `session/new` → `{ sessionId }`.
 *
 * Every approval request the agent emits during the prompt flows
 * through the adapter → mediator → adapter chain set up by
 * `spawnAcpMediated`. Low-risk auto-allows resolve as
 * `outcome: selected → allow_once`; high-risk denials resolve as
 * `outcome: selected → reject_once`; bridge / mediator failures
 * resolve as `outcome: cancelled`.
 */

import {
  spawnAcpMediated,
  type AcpSpawnLike,
  type SpawnAcpMediatedOptions,
} from './acp-mediated-spawn.js'
import type { MediatorLike } from './codex-mediator-connector.js'
import type { JsonRpcStdioBridgeHooks } from './jsonrpc-stdio-bridge.js'

export interface RunAcpMediatedTaskOptions {
  /** Mediator (or test double) — runs risk + approval per request. */
  mediator: MediatorLike
  /** Agent id recorded on every audit row. */
  sourceAgent: string
  /** The user's prompt — fed verbatim to the agent. */
  prompt: string
  /** Working directory the agent inherits. Defaults to
   *  `process.cwd()`. */
  cwd?: string
  /** Optional spawn override for tests. */
  spawnImpl?: AcpSpawnLike
  /** Argv used to spawn the ACP-mode agent. Set by the caller (PR 5
   *  wires this from the registry entry's argv). */
  argv: SpawnAcpMediatedOptions['argv']
  /** Override the initialize capabilities — defaults conservative
   *  (fs / terminal off). */
  capabilities?: SpawnAcpMediatedOptions['capabilities']
  /** Override the ACP protocol version. Defaults to 1. */
  protocolVersion?: number
  /** Hard ceiling on prompt duration. Default 10 minutes, matching
   *  `runMediatedCodexTask` for symmetry. */
  timeoutMs?: number
  /** Env overrides forwarded to the child process. */
  env?: NodeJS.ProcessEnv
  /** Optional bridge hooks (e.g. onNotification to surface
   *  `session/update` streamed deltas to the operator). */
  hooks?: JsonRpcStdioBridgeHooks
}

/** Stage at which an ACP mediated task can fail. Mirrors the codex
 *  runner's failure stages so incident triage at the call site can
 *  treat both transports uniformly. */
export type AcpMediatedFailureStage =
  | 'spawn'
  | 'initialize'
  | 'session'
  | 'prompt'
  | 'timeout'
  | 'transport'

export type AcpMediatedTaskOutcome =
  | {
      ok: true
      /** ACP's session/prompt response payload. The shape varies by
       *  agent (Hermes / OpenClaw / ZeroClaw all add their own
       *  metadata); the runner doesn't constrain it. Caller decides
       *  how to surface it to the operator. */
      result: unknown
      sessionId: string
    }
  | {
      ok: false
      stage: AcpMediatedFailureStage
      error: string
      sessionId?: string
    }

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Run a single ACP-mode prompt end-to-end with Foreman mediation on
 * every outbound action. Resolves once the agent's
 * `session/prompt` response arrives, or once the timeout fires.
 *
 * Lifecycle:
 *   1. Spawn the ACP child with stdio piped.
 *   2. initialize (the spawn helper does this; await
 *      `session.ready`).
 *   3. session/new → get `sessionId`.
 *   4. session/prompt with the user's prompt → await response. All
 *      mid-prompt `session/request_permission` server requests route
 *      through the mediator without further action here.
 *   5. shutdown — SIGTERM child + stop bridge.
 */
export async function runAcpMediatedTask(
  opts: RunAcpMediatedTaskOptions,
): Promise<AcpMediatedTaskOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Timeout guard: race the in-flight ACP request against a timer
  // that rejects with a tagged stage so the catch block returns a
  // structured outcome.
  type StagedError = Error & { stage?: AcpMediatedFailureStage }
  let resolveTimeout!: (err: StagedError) => void
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    resolveTimeout = reject as (err: StagedError) => void
  })
  const timeoutHandle = setTimeout(() => {
    const e = new Error(
      `mediated ACP task timed out after ${timeoutMs}ms`,
    ) as StagedError
    e.stage = 'timeout'
    resolveTimeout(e)
  }, timeoutMs)

  let sessionId: string | undefined
  let stage: 'initialize' | 'session' | 'prompt' = 'initialize'
  let session: ReturnType<typeof spawnAcpMediated> | null = null

  try {
    session = spawnAcpMediated({
      mediator: opts.mediator,
      sourceAgent: opts.sourceAgent,
      cwd: opts.cwd,
      env: opts.env,
      spawnImpl: opts.spawnImpl,
      argv: opts.argv,
      capabilities: opts.capabilities,
      protocolVersion: opts.protocolVersion,
      hooks: {
        ...opts.hooks,
        onTransportError(err) {
          // Surface transport errors to the timeout promise so the
          // pending await unwinds even if the agent's stdio pipe
          // dies mid-prompt. User-supplied onTransportError still
          // fires first.
          opts.hooks?.onTransportError?.(err)
          const e = err as StagedError
          e.stage = 'transport'
          resolveTimeout(e)
        },
      },
    })

    await Promise.race([session.ready, timeoutPromise])

    stage = 'session'
    const newSessionResp = (await Promise.race([
      session.bridge.request('session/new', {}),
      timeoutPromise,
    ])) as { sessionId?: string }
    sessionId = newSessionResp.sessionId
    if (!sessionId) {
      throw new Error('session/new response did not include a sessionId')
    }

    stage = 'prompt'
    const promptResult = await Promise.race([
      session.bridge.request('session/prompt', {
        sessionId,
        prompt: opts.prompt,
      }),
      timeoutPromise,
    ])

    return { ok: true, result: promptResult, sessionId }
  } catch (err) {
    const e = err as StagedError
    const failureStage: AcpMediatedFailureStage = e.stage ?? stage
    return {
      ok: false,
      stage: failureStage,
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    }
  } finally {
    clearTimeout(timeoutHandle)
    if (session) {
      await session.shutdown()
    }
  }
}
