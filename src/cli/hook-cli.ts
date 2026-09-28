import { Command } from "commander";
import {
  AdapterDecodeError,
  getAdapter,
} from "../core/adapters/index.js";
import { DbApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { bus } from "../core/event-bus.js";
import { FOREMAN_MCP_PREFIX, isForemanServedTool } from "../core/foreman-mcp-trust.js";
import { createMediatorStack } from "../core/mediator-stack.js";
import { closeDb, getDb } from "../db/client.js";
import type { JSONRPCMessage } from "../mcp/types.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, red } from "./colors.js";

// =============================================================================
// foreman hook <agent-id> — PreToolUse hook script (#517 Faz 4)
// =============================================================================
//
// Wired from the agent's settings.json by `foreman agent hook install
// claude-code` (#517 Faz 4 / agent-hook.ts). On every matching tool
// call the agent emits, Claude Code spawns:
//
//   foreman hook claude-code
//
// with the PreToolUse JSON payload on stdin:
//
//   { "session_id": "...",
//     "tool_name": "Bash",
//     "tool_input": { "command": "rm -rf /etc" } }
//
// This script:
//   1. Normalises the payload through the claude-code adapter (Bash →
//      shell_exec, Write/Edit → file_write, Read → read_file, …).
//   2. Runs it through the same mediator every other transport uses:
//      policy.yaml, the risk engine, the DB-backed approval bridge (TUI
//      modal + Telegram) and the audit log.
//   3. Exits 0 (allow) or 2 (block) per Claude Code's hook contract.
//
// FAIL CLOSED. Claude Code treats any exit code other than 2 as a
// non-blocking error and runs the tool anyway, so every failure path here —
// unreadable stdin, bad JSON, a locked or corrupt database, an unexpected
// exception — must end in exit 2. An agent that can make Foreman crash
// must not thereby get its tool call through.
//
// Default posture: when policy.yaml has no rule for a call, the hook falls
// back to "allow unless the risk engine objects" — the same risk-based
// behaviour the hook always had — so everyday `ls` / edits are not
// prompted, while explicit policy rules (secret paths, `rm -rf`, per-agent
// denies) now apply to Claude Code too.

const BLOCK = 2;
const ALLOW = 0;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const ADAPTER_ID = "claude-code-pretooluse-v1";
/** Claude Code waits on the hook; with nobody at the TUI this is how long. */
const DEFAULT_HOOK_TIMEOUT_MS = 600_000;

/** `--timeout-ms` wins, then FOREMAN_APPROVAL_TIMEOUT (seconds, like every
 *  other transport), then the 10-minute default. */
export function hookTimeoutMs(flag: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (flag !== undefined) return flag;
  const fromEnv = Number.parseInt(env.FOREMAN_APPROVAL_TIMEOUT ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv * 1000 : DEFAULT_HOOK_TIMEOUT_MS;
}


/** Read the whole stdin into a single string, bounded so a hostile payload
 *  cannot exhaust memory. */
async function readStdin(): Promise<string> {
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

function block(reason: string): never {
  process.stderr.write(`${red("foreman hook:")} ${reason}\n`);
  process.exit(BLOCK);
}

export const hookCommand = new Command("hook")
  .description(
    "PreToolUse hook entrypoint (#517 Faz 4). Wired from the agent's " +
      "settings file by `foreman agent hook install <agent>`. Reads the " +
      "agent's tool-call payload from stdin, gates it through Foreman's " +
      "policy / risk / approval / audit pipeline, and exits 0 (allow) or " +
      "2 (block). Fails closed: any error blocks the call.",
  )
  .argument(
    "<agentId>",
    "Agent id whose tool call is being gated (`claude-code` today).",
  )
  .option(
    "--timeout-ms <ms>",
    "How long to wait for the user's decision before defaulting to block " +
      `(default: FOREMAN_APPROVAL_TIMEOUT seconds when set, else ${DEFAULT_HOOK_TIMEOUT_MS / 60_000} minutes)`,
    (v) => Number.parseInt(v, 10),
  )
  // A usage error (missing agent id, unknown flag) must block too: commander
  // exits 1 by default, which Claude Code treats as "run the tool".
  .exitOverride((err) => {
    if (err.exitCode === 0) process.exit(0); // --help
    process.exit(BLOCK);
  })
  .action(async (agentId: string, opts: { timeoutMs?: number }) => {
    // Anything that escapes the try/catch below (a rejected promise inside
    // a library callback, a synchronous throw from a listener) still blocks.
    // The main CLI installs a handler that rethrows (exit 7, which Claude
    // Code would treat as "run the tool"), so ours must be the only one.
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    process.on("uncaughtException", (err) =>
      block(`internal error (${err.message}) — blocking the call`),
    );
    process.on("unhandledRejection", (err) =>
      block(
        `internal error (${err instanceof Error ? err.message : String(err)}) — blocking the call`,
      ),
    );
    if (opts.timeoutMs !== undefined && !(Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0)) {
      block("--timeout-ms must be a whole number of milliseconds — blocking the call.");
    }
    try {
      const exit = await runHook(agentId, hookTimeoutMs(opts.timeoutMs));
      process.exit(exit);
    } catch (err) {
      block(
        `could not evaluate the call (${err instanceof Error ? err.message : String(err)}) — blocking it. ` +
          "Run `foreman doctor` to diagnose.",
      );
    }
  });

export async function runHook(agentId: string, timeoutMs: number): Promise<0 | 2> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    block(
      `could not read the PreToolUse payload (${
        err instanceof Error ? err.message : String(err)
      }) — blocking the call.`,
    );
  }
  if (!raw.trim()) block("empty PreToolUse payload — blocking the call.");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    block(
      `could not parse the PreToolUse payload (${
        err instanceof Error ? err.message : String(err)
      }) — blocking the call.`,
    );
  }

  const adapter = getAdapter(ADAPTER_ID);
  if (!adapter) block(`adapter ${ADAPTER_ID} is missing from this build — blocking the call.`);
  const toolName =
    typeof payload === "object" && payload !== null
      ? (payload as { tool_name?: unknown }).tool_name
      : undefined;
  // Foreman's own MCP tools are mediated inside `foreman mcp-stdio`; gating
  // them here too would double-prompt. Only when the tool really is ours
  // and no project config swapped in another `foreman` server (#619).
  if (typeof toolName === "string" && toolName.startsWith(FOREMAN_MCP_PREFIX)) {
    const cwdField =
      typeof payload === "object" && payload !== null ? (payload as { cwd?: unknown }).cwd : undefined;
    const cwd = typeof cwdField === "string" && cwdField.length > 0 ? cwdField : process.cwd();
    if (isForemanServedTool(toolName, { cwd, hubConfigPath: getForemanPaths().mcpConfigPath })) {
      return ALLOW;
    }
  }
  let normalised;
  try {
    normalised = adapter.decodeRequest(payload, agentId);
  } catch (err) {
    const reason =
      err instanceof AdapterDecodeError || err instanceof Error ? err.message : String(err);
    block(`malformed PreToolUse payload (${reason}) — blocking the call.`);
  }

  const paths = getForemanPaths();
  const db = getDb();
  const audit = new AuditLogger(db, bus);
  try {
    const approval = new DbApprovalService(db, { bus, timeoutMs });
    const { mediator } = createMediatorStack({
      db,
      bus,
      approval,
      policyPath: paths.policyPath,
    });
    const result = await mediator.handleRequest({
      sourceAgent: normalised.sourceAgent,
      targetTool: normalised.targetTool,
      ...(normalised.sessionId ? { sessionId: normalised.sessionId } : {}),
      message: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: normalised.targetTool, arguments: normalised.args },
      } as JSONRPCMessage,
      policyFallback: { effect: "allow", source: "hook:risk-based" },
    });
    if (result.decision === "allowed") {
      process.stderr.write(
        `${dim("foreman hook:")} ${String(toolName)} allowed (${result.decidedBy}, risk ${result.riskScore}/100).\n`,
      );
      return ALLOW;
    }
    const reasons = result.riskReasons.length > 0 ? `; ${result.riskReasons.join(", ")}` : "";
    process.stderr.write(
      `${red("foreman hook:")} ${String(toolName)} blocked by Foreman (${result.decidedBy}${reasons}, ` +
        `score ${result.riskScore}/100). Review with \`foreman log tail\`; adjust policy.yaml if this was expected.\n`,
    );
    return BLOCK;
  } finally {
    audit.dispose();
    closeDb();
  }
}
