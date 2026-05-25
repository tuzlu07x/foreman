/**
 * Mediated spawn helper for ACP-mode agents.
 *
 * The ACP-side counterpart of `codex-mediated-spawn.ts`. Spawns an
 * agent that speaks the Agent Client Protocol over stdio
 * (Hermes / OpenClaw / ZeroClaw via `<agent> acp`), wires a generic
 * `JsonRpcStdioBridge` against its piped stdin/stdout, runs the ACP
 * `initialize` handshake, and returns a session handle the caller
 * uses to drive `session/new`, `session/prompt`, etc.
 *
 * Scope is intentionally narrow:
 *   - Spawns the ACP process with a caller-supplied argv (defaults
 *     to `<binary> acp` — set by the registry entry; tests pass
 *     a fake spawn).
 *   - Stands up the bridge with the ACP approval-method set
 *     (`session/request_permission`) + the ACP-shaped fail-closed
 *     reply (`{ outcome: { outcome: 'cancelled' } }`).
 *   - Sends `initialize` with the canonical ACP capabilities
 *     payload so the agent is ready to accept session calls.
 *   - Caller owns the session + prompt lifecycle — that's the
 *     `runAcpMediatedTask` runner in a follow-up PR.
 *
 * Mirrors `spawnCodexMediated` structurally; reviewing them side by
 * side should highlight only the protocol-specific deltas.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

import { wireAcpBridgeToMediator } from './acp-mediator-connector.js'
import {
  ACP_APPROVAL_METHODS,
  type AcpRequestPermissionResponse,
  type AcpWireRequest,
} from './adapters/index.js'
import type { MediatorLike } from './codex-mediator-connector.js'
import {
  JsonRpcStdioBridge,
  type JsonRpcStdioBridgeHooks,
} from './jsonrpc-stdio-bridge.js'

/** Spawn shim — pipe stdio because the bridge needs to read frames
 *  from the child and write JSON-RPC requests to it. */
export type AcpSpawnLike = (
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

/** Capabilities Foreman advertises during ACP `initialize`. Conservative
 *  default — Foreman doesn't yet ack file-system / terminal capabilities,
 *  so agents won't emit `fs/*` or `terminal/*` server requests we'd have
 *  to reject. Caller can override to opt into more. */
const DEFAULT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const

/** ACP protocol versions Foreman has been tested against. The agent
 *  echoes back its preferred version; we accept whatever it picks. */
const DEFAULT_PROTOCOL_VERSION = 1

export interface AcpInitializeParams {
  protocolVersion: number
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean }
    terminal?: boolean
    [extra: string]: unknown
  }
}

export interface SpawnAcpMediatedOptions {
  /** Mediator (or test double) — runs risk + approval per request. */
  mediator: MediatorLike
  /** Agent id Foreman records on every audit row (typically 'hermes',
   *  'openclaw', 'zeroclaw'). */
  sourceAgent: string
  /** Working directory the agent inherits. */
  cwd?: string
  /** Env vars merged onto the child env. */
  env?: NodeJS.ProcessEnv
  /** Override the spawn implementation for tests. Defaults to
   *  node:child_process spawn. */
  spawnImpl?: AcpSpawnLike
  /** Argv used to spawn the ACP-mode agent. PR 5 wires this from the
   *  registry entry's `task_acp_command_template`. */
  argv: { command: string; args: string[] }
  /** Override the initialize capabilities payload. Defaults to a
   *  conservative "no fs / terminal" capability set so agents won't
   *  emit those server requests we'd have to reject. */
  capabilities?: AcpInitializeParams['clientCapabilities']
  /** Protocol version Foreman advertises during initialize. Defaults
   *  to 1 (the current ACP spec). Agents echo back their preferred
   *  version in the response. */
  protocolVersion?: number
  /** Optional bridge hooks (onNotification for session/update
   *  streams, onOtherServerRequest for fs/* and terminal/* methods
   *  the caller chooses to handle, onTransportError). When omitted
   *  the spawn helper installs no-op defaults. */
  hooks?: JsonRpcStdioBridgeHooks
}

export interface AcpMediatedSession {
  /** The active JSON-RPC bridge — callers issue session/new,
   *  session/prompt, etc. through this. Stays open until
   *  `shutdown()` resolves. */
  bridge: JsonRpcStdioBridge<AcpWireRequest, AcpRequestPermissionResponse>
  /** The ACP-mode child process. */
  process: ChildProcess
  /** Resolves once the agent acknowledges `initialize`. Callers
   *  should `await` this before issuing `session/new`. */
  ready: Promise<unknown>
  /** SIGTERM the child and stop the bridge. Idempotent. */
  shutdown: () => Promise<void>
}

export class AcpSpawnValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpSpawnValidationError'
  }
}

/**
 * Spawn an ACP-mode agent, wire the bridge, send initialize. Returns
 * once the child has been spawned + the bridge is listening; further
 * lifecycle (session/new, prompts, shutdown) is observed via the
 * returned handle.
 *
 * Throws `AcpSpawnValidationError` synchronously on a malformed argv.
 * Other failures (spawn errors, ACP init rejection) surface via the
 * returned `ready` promise or the child's `exited` event.
 */
export function spawnAcpMediated(
  options: SpawnAcpMediatedOptions,
): AcpMediatedSession {
  if (
    !options.argv ||
    typeof options.argv.command !== 'string' ||
    options.argv.command.trim().length === 0
  ) {
    throw new AcpSpawnValidationError('spawnAcpMediated: argv.command is empty')
  }

  const spawnFn = options.spawnImpl ?? (nodeSpawn as unknown as AcpSpawnLike)
  const child = spawnFn(options.argv.command, options.argv.args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (!child.stdin || !child.stdout) {
    throw new AcpSpawnValidationError(
      'spawnAcpMediated: spawned process is missing piped stdin/stdout',
    )
  }

  // Build the generic bridge with ACP-specific bindings:
  //   - approval method set: only `session/request_permission` today
  //     (fs/* and terminal/* are out of scope for the approval slice
  //     and route to onOtherServerRequest instead)
  //   - fail-closed reply: ACP-shaped cancelled outcome
  //   - label: 'AcpBridge' so error messages stay legible
  const bridge = new JsonRpcStdioBridge<
    AcpWireRequest,
    AcpRequestPermissionResponse
  >({
    input: child.stdout,
    output: child.stdin,
    approvalMethods: new Set(ACP_APPROVAL_METHODS),
    onApprovalRequest: wireAcpBridgeToMediator({
      sourceAgent: options.sourceAgent,
      mediator: options.mediator,
    }),
    failClosedReply: () => ({ outcome: { outcome: 'cancelled' as const } }),
    hooks: options.hooks,
    label: 'AcpBridge',
  })
  bridge.start()

  // Kick off ACP initialize eagerly. Callers await `ready` before
  // session/new so the timing isn't observable from outside, but
  // starting it eagerly minimises wall-clock latency.
  const params: AcpInitializeParams = {
    protocolVersion: options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    clientCapabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
  }
  const ready = bridge.request('initialize', params)

  let shutdownOnce = false
  const shutdown = async (): Promise<void> => {
    if (shutdownOnce) return
    shutdownOnce = true
    bridge.stop()
    try {
      child.kill('SIGTERM')
    } catch {
      // Best-effort — child may have already exited.
    }
  }

  return { bridge, process: child, ready, shutdown }
}
