import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parse as parseShell } from "shell-quote";
import type { AgentEntry } from "./registry-catalog.js";

// =============================================================================
// Generic agent spawn engine (multi-agent orchestration PR C of 5)
// =============================================================================
//
// Spawns any registered agent non-interactively to execute a single task,
// captures its output, enforces a timeout, and returns a structured outcome.
//
// Reads two registry fields (added in PR B):
//   - task_command_template — shell-like template, e.g. `codex exec "{task}"`.
//     The literal token `{task}` is substituted with the user-provided
//     task text as a SINGLE argv element. No shell layer between us and
//     the child, so embedded shell metachars in the task can't escape into
//     command injection. (We use `{task}` not `${task}` so shell-quote's
//     tokenizer doesn't try to env-expand it.)
//   - task_timeout_seconds — soft cap. Default 300s when unset. We send
//     SIGTERM at the limit, SIGKILL 5s after that if the child is still
//     alive.
//
// Pure-ish — accepts `spawnImpl` override for tests so we can simulate
// subprocesses without forking real binaries.

const DEFAULT_TIMEOUT_MS = 300_000;
const KILL_GRACE_MS = 2_000;
// We use `{task}` (no `$`) so shell-quote's argv tokenizer doesn't
// interpret it as shell variable expansion. With `${task}` shell-quote
// would expand to the env var `task` (typically empty) BEFORE we run
// our substitution, losing the placeholder entirely.
const TASK_TOKEN = "{task}";

export interface SpawnAgentTaskOptions {
  /** Registry entry for the target agent. Must have task_command_template
   *  set; otherwise the outcome is `unsupported` with a clear reason. */
  entry: AgentEntry;
  /** The user-provided task text. Substituted into the template as a
   *  single argv element — embedded shell metachars are NOT interpreted. */
  task: string;
  /** Override the per-agent timeout (defaults to entry.task_timeout_seconds
   *  * 1000, or 300 000ms when both are unset). */
  timeoutMs?: number;
  /** Streaming callback for live output. Called once per line of stdout
   *  or stderr the child produces. The same content is also captured in
   *  the returned outcome — this is for "live progress" rendering. */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  /** Working directory for the spawned process. Defaults to the current
   *  cwd (agents typically operate on whatever project they were
   *  pointed at via the task text). */
  cwd?: string;
  /** Environment overrides merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override the spawn implementation — tests inject a stub. */
  spawnImpl?: SpawnLike;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell: false;
    detached?: boolean;
  },
) => ChildProcessWithoutNullStreams;

export type SpawnAgentTaskOutcome =
  | {
      kind: "ok";
      exitCode: 0;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      kind: "failed";
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      kind: "timeout";
      stdout: string;
      stderr: string;
      durationMs: number;
      timeoutMs: number;
    }
  | {
      kind: "unsupported";
      reason: string;
    }
  | {
      kind: "spawn-error";
      error: string;
    };

/**
 * Spawn `entry`'s agent non-interactively with `task` and capture the
 * result. See module docstring for guarantees.
 */
export async function spawnAgentTask(
  options: SpawnAgentTaskOptions,
): Promise<SpawnAgentTaskOutcome> {
  const template = options.entry.task_command_template;
  if (!template) {
    return {
      kind: "unsupported",
      reason: `agent "${options.entry.id}" has no task_command_template — not invocable via foreman write`,
    };
  }

  const argv = buildArgvFromTemplate(template, options.task);
  if (argv === null) {
    return {
      kind: "unsupported",
      reason: `agent "${options.entry.id}"'s task_command_template did not yield a command + args (parse failed)`,
    };
  }
  const [command, ...args] = argv;
  if (!command) {
    return {
      kind: "unsupported",
      reason: `agent "${options.entry.id}"'s task_command_template is empty`,
    };
  }

  const timeoutMs =
    options.timeoutMs ??
    (options.entry.task_timeout_seconds
      ? options.entry.task_timeout_seconds * 1000
      : DEFAULT_TIMEOUT_MS);

  const spawnFn = options.spawnImpl ?? nodeSpawn;
  // QA round 13 (bug 3) defensive fix: when Foreman's mcp-stdio is the
  // process running the drain handler, the spawned agent (e.g. codex)
  // may have its own MCP wiring to Foreman, which would spawn a
  // RECURSIVE `foreman mcp-stdio` subprocess. That recursive instance
  // polls the same control_commands table and can race with the parent
  // poller, or worse, deadlock against it (parent awaits spawn → child
  // awaits parent's MCP response → both stuck). Mark the env so the
  // recursive Foreman knows to bail out of its drain poller. Also
  // bump a depth counter so any further nesting is visible in audit.
  const currentDepth = Number(process.env.FOREMAN_SPAWN_DEPTH ?? "0") || 0;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
    FOREMAN_SPAWN_DEPTH: String(currentDepth + 1),
    FOREMAN_SPAWNED_BY: options.entry.id,
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn(command, args, {
      cwd: options.cwd,
      env: childEnv,
      shell: false,
      // Detached so the child is the leader of its own process group.
      // On timeout we kill `-child.pid` (the group) so any grandchildren
      // (e.g. shell-script-launched `sleep`) die too — not just the
      // top-level shell. Without this, scripts that fork helpers leak
      // orphan processes when timeout hits.
      detached: true,
    });
  } catch (err) {
    return {
      kind: "spawn-error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return runChild(child, timeoutMs, options.onLine);
}


/**
 * Parse the template and substitute `${task}` with the literal task text
 * as a single argv element. Exported for tests so callers can verify the
 * argv shape without spawning.
 *
 * Returns null when shell-quote can't parse the template (rare —
 * malformed escapes). The first element of the array is the command;
 * the rest are args. `${task}` substitution preserves the task text
 * AS A SINGLE arg even when it contains spaces.
 */
export function buildArgvFromTemplate(
  template: string,
  task: string,
): string[] | null {
  const tokens = parseShell(template);
  // shell-quote.parse can emit `{ op: "..." }` operator objects for
  // shell redirection / pipes. We don't support those in a template
  // — bail out cleanly rather than feed a broken argv to spawn().
  const stringTokens: string[] = [];
  for (const t of tokens) {
    if (typeof t === "string") {
      stringTokens.push(t);
    } else if (
      t !== null &&
      typeof t === "object" &&
      "pattern" in t &&
      typeof (t as { pattern?: unknown }).pattern === "string"
    ) {
      // Glob pattern objects (from shell-quote): keep the literal.
      stringTokens.push((t as { pattern: string }).pattern);
    } else {
      // Operator (|, >, &&, etc.) — not allowed in a task template.
      return null;
    }
  }
  return stringTokens.map((tok) => tok.replace(TASK_TOKEN, task));
}

function runChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  onLine?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<SpawnAgentTaskOutcome> {
  const startedAt = Date.now();
  return new Promise<SpawnAgentTaskOutcome>((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let killGraceTimer: NodeJS.Timeout | null = null;
    const lineSplit = (
      stream: "stdout" | "stderr",
      previous: string,
      chunk: string,
    ): string => {
      const text = previous + chunk;
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) return text;
      const complete = text.slice(0, lastNewline);
      if (onLine) {
        for (const line of complete.split("\n")) {
          onLine(stream, line);
        }
      }
      return text.slice(lastNewline + 1);
    };
    let stdoutTail = "";
    let stderrTail = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      stdoutTail = lineSplit("stdout", stdoutTail, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      stderrTail = lineSplit("stderr", stderrTail, chunk);
    });
    const killGroup = (signal: NodeJS.Signals): void => {
      // detached:true makes the child its own process group leader.
      // `process.kill(-pid, signal)` signals the entire group, killing
      // shell-script grandchildren (sleep, npm scripts, etc.) along
      // with the immediate child.
      if (child.pid && child.pid > 0) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Group may already be gone — fall back to direct child kill.
          try {
            child.kill(signal);
          } catch {
            /* swallow — child already dead */
          }
        }
      }
    };
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killGraceTimer = setTimeout(() => {
        if (!child.killed) killGroup("SIGKILL");
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve({
        kind: "spawn-error",
        error: err.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      // Flush trailing partial line through onLine, if any.
      if (onLine) {
        if (stdoutTail) onLine("stdout", stdoutTail);
        if (stderrTail) onLine("stderr", stderrTail);
      }
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        resolve({
          kind: "timeout",
          stdout: stdoutBuf,
          stderr: stderrBuf,
          durationMs,
          timeoutMs,
        });
        return;
      }
      if (code === 0) {
        resolve({
          kind: "ok",
          exitCode: 0,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          durationMs,
        });
        return;
      }
      resolve({
        kind: "failed",
        exitCode: typeof code === "number" ? code : -1,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        durationMs,
      });
    });
  });
}
