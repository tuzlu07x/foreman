/**
 * Mediated codex spawn helper (#552 PR 4).
 *
 * Composes the three pieces this epic already shipped — adapter (PR 1),
 * MCP tool / mediator (PR 2), bridge (PR 3) — into a single function the
 * call site can use to bring a codex exec-server session up with full
 * approval mediation wired.
 *
 * Scope is intentionally narrow:
 *
 *   - Spawns `codex exec-server --listen stdio` (override-able for tests).
 *   - Stands up a CodexBridge against the child's stdio.
 *   - Sends `initialize` with `clientInfo` so the server is ready to accept
 *     thread/turn calls (verified field shape against the schema bundle
 *     produced by `codex app-server generate-json-schema`).
 *   - Wires the bridge's `onApprovalRequest` to the mediator via the
 *     PR 4 connector.
 *
 * The caller still owns the *thread* + *turn* lifecycle —
 * `bridge.request('thread/start', ...)`, `bridge.request('turn/start', ...)`,
 * listening for `turn/completed` notifications — because those carry
 * caller-specific context (cwd, prompt, model, environments) that the
 * spawn helper has no business deciding for them. Concrete templates land
 * in the registry-driven dispatcher in a follow-up PR.
 *
 * The full agent-spawn.ts integration (PID files, audit rows, timeout
 * supervision, env stripping) is NOT yet wired here — that work belongs
 * in PR 5 alongside the chat-surface fixes. Keeping this helper standalone
 * lets the connector + bridge + adapter compose live end-to-end without
 * disrupting the existing spawn engine.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

import { CodexBridge, type CodexBridgeHooks } from "./codex-bridge.js";
import {
  wireBridgeToMediator,
  type MediatorLike,
} from "./codex-mediator-connector.js";

/** Stub-able spawn type — mirrors the shape `agent-spawn.ts` exports so
 *  test doubles can be reused if useful. We require pipe stdin/stdout
 *  because the bridge needs to write requests to the child and read
 *  frames back; that's the entire point of `exec-server --listen stdio`. */
export type CodexSpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell: false;
    detached?: boolean;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcess;

const DEFAULT_CLIENT_NAME = "foreman";
const DEFAULT_CLIENT_VERSION = "0.1.3";

export interface SpawnCodexMediatedOptions {
  /** Mediator (or test double) — runs risk + approval per request. */
  mediator: MediatorLike;
  /** Agent id Foreman records on every audit row (typically 'codex'). */
  sourceAgent: string;
  /** Working directory codex inherits. Mostly relevant for the
   *  subsequent `thread/start` call, but also lets a sandbox-aware spawn
   *  policy land the child in a consistent place. */
  cwd?: string;
  /** Env vars to merge onto the child env. process.env passes through;
   *  callers add per-spawn overrides via this map. */
  env?: NodeJS.ProcessEnv;
  /** Override the spawn implementation for tests. Defaults to
   *  node:child_process spawn. */
  spawnImpl?: CodexSpawnLike;
  /** Argv used to spawn the codex exec-server. Defaults to the
   *  canonical invocation. Tests pass a fake binary; the spawn engine
   *  in PR 5 will pass `task_mediated_command_template` once we add
   *  that field. */
  argv?: { command: string; args: string[] };
  /** Override the initialize client info — defaults are 'foreman' /
   *  Foreman's own version. */
  clientInfo?: { name: string; version: string };
  /** Optional bridge hooks (onNotification, onTransportError, etc.).
   *  When omitted the spawn helper installs sensible defaults that
   *  forward to the audit log. PR 5 wires the audit hookup; for now the
   *  defaults are no-ops so unit tests don't need to stub anything. */
  hooks?: CodexBridgeHooks;
}

export interface CodexMediatedSession {
  /** The active JSON-RPC bridge — callers issue thread/turn requests
   *  through this. Stays open until `shutdown()` resolves. */
  bridge: CodexBridge;
  /** The codex child process. Tests can `.kill()` directly; the
   *  helper's `shutdown()` does it properly. */
  process: ChildProcess;
  /** Resolves once codex acknowledges `initialize`. Callers should
   *  `await` this before issuing thread/start. */
  ready: Promise<unknown>;
  /** Send SIGTERM to the child and stop the bridge. Idempotent. */
  shutdown: () => Promise<void>;
}

/**
 * Spawn codex in exec-server mode, wire the bridge, send initialize.
 *
 * Throws synchronously on a malformed argv override (caller supplied an
 * empty command). Spawn failures propagate as the underlying child's
 * `error` event — observable via the returned process.
 */
export function spawnCodexMediated(
  options: SpawnCodexMediatedOptions,
): CodexMediatedSession {
  const argv = options.argv ?? {
    command: "codex",
    args: ["exec-server", "--listen", "stdio"],
  };
  if (!argv.command || argv.command.trim().length === 0) {
    throw new Error("spawnCodexMediated: argv.command is empty");
  }

  const spawnFn = options.spawnImpl ?? (nodeSpawn as unknown as CodexSpawnLike);
  const child = spawnFn(argv.command, argv.args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout) {
    throw new Error(
      "spawnCodexMediated: spawned process is missing piped stdin/stdout",
    );
  }

  const bridge = new CodexBridge({
    input: child.stdout,
    output: child.stdin,
    onApprovalRequest: wireBridgeToMediator({
      sourceAgent: options.sourceAgent,
      mediator: options.mediator,
    }),
    hooks: options.hooks,
  });
  bridge.start();

  // Kick off initialize immediately — the caller awaits `ready` before
  // issuing thread/start, so the timing isn't observable from outside,
  // but starting it eagerly minimises wall-clock latency.
  const clientInfo = options.clientInfo ?? {
    name: DEFAULT_CLIENT_NAME,
    version: DEFAULT_CLIENT_VERSION,
  };
  const ready = bridge.request("initialize", { clientInfo });

  let shutdownOnce = false;
  const shutdown = async () => {
    if (shutdownOnce) return;
    shutdownOnce = true;
    bridge.stop();
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort — child may have already exited.
    }
  };

  return {
    bridge,
    process: child,
    ready,
    shutdown,
  };
}
