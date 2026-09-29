import { homedir } from "node:os";
import { connectDaemon } from "../core/daemon/client.js";
import { LineReader, MAX_DAEMON_LINE, parseObjectLine } from "../core/daemon/protocol.js";
import { resolveDirs } from "../utils/config.js";
import { dim, red } from "./colors.js";

// =============================================================================
// The PreToolUse hook's client side (#616)
// =============================================================================
//
// With `foreman start` running, the hook hands the payload to the daemon,
// which mediates it with the stack it already has loaded, and exits with
// the daemon's answer. Without a daemon it runs the whole stack itself
// (hook-cli.ts), as it always did. This file is all the fast hook loads
// before it knows which, so it stays free of the database and the
// mediation stack.
//
// Fail closed, as everywhere in the hook: once the payload has been sent,
// a daemon that goes away, answers garbage or never answers blocks the
// call (exit 2). The in-process fallback is only chosen before anything
// is sent.

export const HOOK_ALLOW = 0;
export const HOOK_BLOCK = 2;
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** Claude Code waits on the hook; with nobody at the TUI this is how long. */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000;
/** How long past the approval window a client waits for the daemon's
 *  answer before it blocks the call on its own. */
const DAEMON_ANSWER_GRACE_MS = 30_000;

/** `--timeout-ms` wins, then FOREMAN_APPROVAL_TIMEOUT (seconds, like every
 *  other transport), then the 10-minute default. */
export function hookTimeoutMs(flag: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (flag !== undefined) return flag;
  const fromEnv = Number.parseInt(env.FOREMAN_APPROVAL_TIMEOUT ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv * 1000 : DEFAULT_HOOK_TIMEOUT_MS;
}

/** Read the whole stdin into a single string, bounded so a hostile payload
 *  cannot exhaust memory. */
export function readHookStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_PAYLOAD_BYTES) {
        reject(new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`));
        process.stdin.destroy();
      }
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

export interface HookLine {
  level: "info" | "error";
  text: string;
}

export function writeHookLines(lines: readonly HookLine[]): void {
  for (const line of lines) {
    const prefix = line.level === "error" ? red("foreman hook:") : dim("foreman hook:");
    process.stderr.write(`${prefix} ${line.text}\n`);
  }
}

export function blockHook(reason: string): never {
  writeHookLines([{ level: "error", text: reason }]);
  process.exit(HOOK_BLOCK);
}

/** What the daemon needs to decide the way this process would: where the
 *  hook runs, whose home it reads and which Foreman it is (#619). */
export function hookProcessContext(env: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  return {
    cwd: process.cwd(),
    home: homedir(),
    path: env.PATH ?? "",
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null,
    argv1: process.argv[1] ?? null,
    execPath: process.execPath,
    spawnedBy: env.FOREMAN_SPAWNED_BY ?? null,
  };
}

/**
 * Ask the daemon. Returns the exit code to use, or null when no daemon
 * could be used and nothing was sent (run the in-process path).
 */
export async function hookViaDaemon(
  agentId: string,
  timeoutMs: number,
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<0 | 2 | null> {
  const { stateDir } = resolveDirs({ foremanHome: env.FOREMAN_HOME ?? null });
  const connected = await connectDaemon({ stateDir, auth: { role: "hook" }, env });
  if (connected.kind === "absent") {
    if (connected.notable) {
      writeHookLines([{ level: "info", text: `not using the Foreman daemon: ${connected.reason}; deciding here.` }]);
    }
    return null;
  }
  if (connected.kind === "refused") {
    writeHookLines([{ level: "error", text: `the Foreman daemon refused this hook (${connected.reason}) — blocking the call.` }]);
    return HOOK_BLOCK;
  }
  const { socket, reader, pending } = connected.link;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exit: 0 | 2, lines: HookLine[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      writeHookLines(lines);
      socket.destroy();
      resolve(exit);
    };
    const lost = (why: string): void =>
      settle(HOOK_BLOCK, [{ level: "error", text: `${why} — blocking the call. Review with \`foreman log tail\`.` }]);
    // The daemon enforces the approval window; this only covers a daemon
    // that hangs, which must not end in Claude Code's own timeout (that
    // runs the tool).
    const guard = setTimeout(
      () => lost("the Foreman daemon did not answer in time"),
      Math.min(timeoutMs + DAEMON_ANSWER_GRACE_MS, 2_147_000_000),
    );
    reader.setMaxLine(MAX_DAEMON_LINE);
    const onLines = (lines: string[]): void => {
      for (const line of lines) {
        const msg = parseObjectLine(line);
        if (!msg || msg.t !== "result") return lost("the Foreman daemon sent an invalid answer");
        // Only an explicit, well-formed allow allows.
        const exit = msg.exit === HOOK_ALLOW ? HOOK_ALLOW : HOOK_BLOCK;
        return settle(exit, parseLines(msg.lines));
      }
    };
    socket.on("data", (chunk: string) => {
      const lines = reader.push(chunk);
      if (lines === "overflow") return lost("the Foreman daemon sent an oversized answer");
      onLines(lines);
    });
    socket.on("close", () => lost("the Foreman daemon went away before deciding"));
    if (connected.link.isClosed()) return lost("the Foreman daemon went away before deciding");
    socket.write(
      `${JSON.stringify({ t: "hook", agentId, timeoutMs, payload: raw, ctx: hookProcessContext(env) })}\n`,
    );
    socket.resume();
    onLines(pending);
  });
}

function parseLines(value: unknown): HookLine[] {
  if (!Array.isArray(value)) return [];
  const out: HookLine[] = [];
  for (const entry of value.slice(0, 20)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { level, text } = entry as { level?: unknown; text?: unknown };
    if (typeof text !== "string") continue;
    out.push({ level: level === "error" ? "error" : "info", text: text.slice(0, 4000) });
  }
  return out;
}

/** `<agentId> [--timeout-ms <ms>]`, the shape the installed hook command
 *  has. Anything else (help, unknown flags, a usage error) goes to the
 *  full command, which knows how to answer it. */
export function fastHookArgs(argv: readonly string[]): { agentId: string; timeoutFlag: number | undefined } | null {
  let agentId: string | undefined;
  let timeoutFlag: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === "--timeout-ms") value = argv[++i];
    else if (arg.startsWith("--timeout-ms=")) value = arg.slice("--timeout-ms=".length);
    else if (arg.startsWith("-") || agentId !== undefined) return null;
    else {
      agentId = arg;
      continue;
    }
    if (value === undefined || !/^\d+$/.test(value) || timeoutFlag !== undefined) return null;
    timeoutFlag = Number.parseInt(value, 10);
  }
  return agentId === undefined ? null : { agentId, timeoutFlag };
}
