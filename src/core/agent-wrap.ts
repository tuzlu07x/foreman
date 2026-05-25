/**
 * Agent wrap orchestrator (#445 PR 2).
 *
 * Owns the lifecycle for a single chat-only daemon agent:
 *
 *   1. Spawn the agent's gateway as a child process with piped stdio.
 *   2. Stand up a Telegram getUpdates poller (#445 PR 2) — owner-filtered.
 *   3. For each accepted update, serialise it as JSONL and write to the
 *      child's stdin per the agent's `input_protocol.synthetic_update_template`
 *      schema (currently `telegram-update` over `stdin_jsonl`).
 *   4. On shutdown, stop the poller + SIGTERM the child + drain stdout/stderr.
 *
 * Scope of this PR (#445 PR 2):
 *   - User → agent direction only.
 *   - No directive injection from `/foreman write` (PR 3).
 *   - No `foreman start` integration (PR 5).
 *   - No real Hermes / OpenClaw registry entries (PR 4).
 *
 * The class is intentionally agnostic of HOW it's launched — the CLI
 * subcommand wires `process.env` / registry / secret store and instantiates
 * one of these. Tests instantiate directly with in-memory streams + fake
 * fetch.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
} from 'node:child_process'

import type { ControlChannel } from './control-channel.js'
import { DirectiveSource } from './directive-source.js'
import { renderSyntheticUpdate } from './synthetic-update-renderer.js'
import {
  TelegramPoller,
  serializeUpdateAsJsonl,
  type PollerFetchLike,
  type TelegramUpdate,
} from './telegram-poller.js'
import type { AgentEntry } from './registry-catalog.js'

/** Spawn shim mirroring the shape `agent-spawn.ts` uses. AgentWrap
 *  takes whichever stdio mode the caller wants; production wants
 *  ['pipe','pipe','pipe']. */
export type WrapSpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    shell: false
    detached?: boolean
    stdio: ['pipe', 'pipe', 'pipe']
  },
) => ChildProcess

export interface AgentWrapOptions {
  /** Registry entry for the agent we're wrapping. Must declare
   *  `input_protocol` — the constructor throws if it does not, so
   *  callers cannot accidentally wrap an agent that has nothing to
   *  inject into. */
  entry: AgentEntry
  /** Telegram bot token (no `bot` prefix). Sourced from the secret
   *  store / env at the CLI layer; AgentWrap is pure logic. */
  botToken: string
  /** Telegram chat id of the registered owner (numeric). */
  ownerChatId: number
  /** Argv used to spawn the agent's gateway child. The CLI resolves
   *  this from the registry entry's `daemon` block; we accept it
   *  explicitly so tests can drive a fake. */
  childArgv: { command: string; args: string[] }
  /** Optional cwd / env for the spawned child. */
  childCwd?: string
  childEnv?: NodeJS.ProcessEnv
  /** Spawn override (tests). */
  spawnImpl?: WrapSpawnLike
  /** Fetch override forwarded to the poller (tests). */
  fetchImpl?: PollerFetchLike
  /** setTimeout override forwarded to the poller (tests). */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown
  /** Long-poll seconds forwarded to the poller. Defaults to the
   *  poller's default (25). */
  longPollSeconds?: number
  /** Diagnostic sink — fired for spawn / poller / forward errors so
   *  the CLI can log them. Defaults to no-op. */
  onError?(err: Error): void
  /** #445 PR 3 — Optional ControlChannel handle. When supplied, the
   *  wrap also drains `command='write'` rows from the #440
   *  control_commands queue targeted at this agent, renders the
   *  agent's `synthetic_update_template` per directive, and writes
   *  the rendered JSON as a JSONL frame to child stdin (same path
   *  Telegram updates use). When omitted, the wrap only forwards
   *  real Telegram updates — directive injection is off. */
  controlChannel?: ControlChannel
  /** Polling interval (ms) for the directive source. Forwarded to
   *  DirectiveSource; defaults to 1000. */
  directivePollIntervalMs?: number
  /** Optional timer overrides forwarded to DirectiveSource (tests). */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
}

/** Live handle to a running wrap process. */
export interface AgentWrapHandle {
  /** The active Telegram poller. */
  poller: TelegramPoller
  /** The active directive source (#445 PR 3). Null when no
   *  ControlChannel was supplied — wrap operates in user-only mode. */
  directiveSource: DirectiveSource | null
  /** The active child. */
  process: ChildProcess
  /** Resolves once the child exits. Useful for the CLI's main loop. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Stop the poller(s) + SIGTERM the child + await its exit. Idempotent. */
  shutdown(): Promise<void>
}

export class AgentWrapValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentWrapValidationError'
  }
}

/**
 * Spin up a wrap process for the supplied agent. Returns once the
 * child has been spawned + the poller has been started; further
 * lifecycle (updates flowing, shutdown) is observed via the returned
 * handle.
 *
 * Throws `AgentWrapValidationError` synchronously if the registry
 * entry lacks an `input_protocol`. Other failures (spawn errors,
 * Telegram auth failure) surface via `onError` or the returned
 * `exited` promise.
 */
export function startAgentWrap(opts: AgentWrapOptions): AgentWrapHandle {
  const protocol = opts.entry.input_protocol
  if (!protocol) {
    throw new AgentWrapValidationError(
      `agent "${opts.entry.id}" cannot be wrap-launched: registry entry has no \`input_protocol\` block. See #445 for the schema. Configure \`approval_adapter\` instead if this agent ships a programmable transport.`,
    )
  }
  if (protocol.method !== 'stdin_jsonl') {
    throw new AgentWrapValidationError(
      `agent "${opts.entry.id}" declares input_protocol.method="${protocol.method}"; only "stdin_jsonl" is implemented in #445 PR 2.`,
    )
  }
  if (protocol.schema !== 'telegram-update') {
    throw new AgentWrapValidationError(
      `agent "${opts.entry.id}" declares input_protocol.schema="${protocol.schema}"; only "telegram-update" is implemented in #445 PR 2.`,
    )
  }

  // Spawn the agent's gateway child. We use the same stdio shape as
  // codex-mediated-spawn (#552 PR 4) so AgentWrap can read both
  // stdout (for log forwarding in PR 5) and write stdin (for update
  // injection now + directive injection in PR 3).
  const spawnFn =
    opts.spawnImpl ?? (nodeSpawn as unknown as WrapSpawnLike)
  const child = spawnFn(opts.childArgv.command, opts.childArgv.args, {
    cwd: opts.childCwd,
    env: { ...process.env, ...(opts.childEnv ?? {}) },
    shell: false,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (!child.stdin) {
    throw new AgentWrapValidationError(
      `spawned child for "${opts.entry.id}" has no stdin — cannot inject Telegram updates.`,
    )
  }

  // Resolve the child's exit so the CLI's main loop can await it
  // and surface a non-zero code as the wrap process exit code.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    },
  )

  // Forward poller errors to the diagnostic sink — child crashes
  // surface via the `exited` promise, but transport / Telegram
  // failures stream through here.
  const errorSink = opts.onError ?? (() => {})

  const poller = new TelegramPoller({
    botToken: opts.botToken,
    ownerChatId: opts.ownerChatId,
    longPollSeconds: opts.longPollSeconds,
    fetchImpl: opts.fetchImpl,
    setTimeoutImpl: opts.setTimeoutImpl,
    onError: errorSink,
    onUpdate(update: TelegramUpdate) {
      // Best-effort write. If the child's stdin is closed (it crashed
      // or shut itself down), drop the update on the floor and let the
      // `exited` promise drive the wrap's exit. We don't queue and
      // retry — the agent already lost its connection to the user, and
      // replaying stale updates after a restart causes confusion.
      const stdin = child.stdin
      if (!stdin || stdin.destroyed) return
      try {
        stdin.write(serializeUpdateAsJsonl(update))
      } catch (err) {
        errorSink(err instanceof Error ? err : new Error(String(err)))
      }
    },
  })

  poller.start()

  // #445 PR 3 — Directive source wiring. When the caller supplied a
  // ControlChannel, the wrap also drains `write` directives from the
  // #440 queue. Each directive renders against the agent's declared
  // synthetic_update_template (with `{auto}` allocated from a wrap-
  // local counter, `{ownerChatId}` from options, `{directive}` from
  // the row's args) and the rendered JSON is written as a JSONL
  // frame to the child's stdin — identical to the Telegram-update
  // path so the agent's input parser handles both uniformly.
  let directiveSource: DirectiveSource | null = null
  if (opts.controlChannel) {
    // Wrap-local update_id counter — independent of Telegram's offset
    // because Telegram never sees these synthetic frames. Start at a
    // large negative-ish offset so synthetic ids cannot collide with
    // real Telegram update_ids the agent's downstream filter might
    // cache. (Telegram's update_id space is unsigned 32-bit; we use
    // the negative half so the two streams never alias.)
    let nextSyntheticUpdateId = -1
    directiveSource = new DirectiveSource({
      channel: opts.controlChannel,
      agentId: opts.entry.id,
      pollIntervalMs: opts.directivePollIntervalMs,
      setIntervalImpl: opts.setIntervalImpl,
      clearIntervalImpl: opts.clearIntervalImpl,
      onError: errorSink,
      async onDirective({ body }) {
        const rendered = renderSyntheticUpdate(
          protocol.synthetic_update_template,
          {
            autoUpdateId: nextSyntheticUpdateId,
            ownerChatId: opts.ownerChatId,
            directive: body,
          },
        )
        nextSyntheticUpdateId -= 1

        const stdin = child.stdin
        if (!stdin || stdin.destroyed) {
          return { ok: false, error: 'child stdin closed before directive could be injected' }
        }
        try {
          const json = JSON.stringify(rendered) + '\n'
          stdin.write(json)
          return { ok: true }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { ok: false, error: message }
        }
      },
    })
    directiveSource.start()
    // Kick off an immediate drain so callers (and tests) don't have
    // to wait the full pollIntervalMs for the first directive.
    void directiveSource.drainOnce()
  }

  let stopped = false
  const shutdown = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    poller.stop()
    directiveSource?.stop()
    try {
      child.kill('SIGTERM')
    } catch {
      // Best-effort — the child may have already exited.
    }
    // Don't await `exited` here — callers do that explicitly via the
    // handle. shutdown() is fire-and-forget so signal handlers don't
    // hang.
  }

  return { poller, directiveSource, process: child, exited, shutdown }
}
