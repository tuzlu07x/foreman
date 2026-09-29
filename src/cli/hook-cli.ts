import { RegistryService } from "../core/registry.js";
import { Command } from "commander";
import { ulid } from "ulid";
import {
  AdapterDecodeError,
  getAdapter,
} from "../core/adapters/index.js";
import { DbApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { bus as processBus, type EventBus, type ForemanEventMap } from "../core/event-bus.js";
import {
  FOREMAN_MCP_PREFIX,
  isForemanServedTool,
  type ForemanSelf,
} from "../core/foreman-mcp-trust.js";
import { createMediatorStack } from "../core/mediator-stack.js";
import { closeDb, getDb, type ForemanDb } from "../db/client.js";
import type { JSONRPCMessage } from "../mcp/types.js";
import { getForemanPaths } from "../utils/config.js";
import {
  blockHook,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_ALLOW,
  HOOK_BLOCK,
  hookTimeoutMs,
  hookViaDaemon,
  readHookStdin,
  writeHookLines,
  type HookLine,
} from "./hook-client.js";

export { hookTimeoutMs } from "./hook-client.js";

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
// With `foreman start` running, steps 1–2 happen in its daemon (#616):
// evaluateHookPayload below runs there, on the same payload, with the
// same stack, so the decision is the same either way; only the start-up
// cost is gone.
//
// FAIL CLOSED. Claude Code treats any exit code other than 2 as a
// non-blocking error and runs the tool anyway, so every failure path here —
// unreadable stdin, bad JSON, a locked or corrupt database, an unexpected
// exception, a daemon that dies mid-call — must end in exit 2. An agent
// that can make Foreman crash must not thereby get its tool call through.
//
// Default posture: when policy.yaml has no rule for a call, the hook falls
// back to "allow unless the risk engine objects" — the same risk-based
// behaviour the hook always had — so everyday `ls` / edits are not
// prompted, while explicit policy rules (secret paths, `rm -rf`, per-agent
// denies) now apply to Claude Code too.

const ADAPTER_ID = "claude-code-pretooluse-v1";

export interface HookVerdict {
  exit: 0 | 2;
  lines: HookLine[];
}

export interface HookEvaluation {
  /** The database, bus and audit flush to mediate with; opened only once
   *  the payload decodes. */
  open(): { db: ForemanDb; bus: EventBus<ForemanEventMap>; flushAudit(): void };
  policyPath: string;
  mcpConfigPath: string;
  timeoutMs: number;
  /** The hook process: its working directory (when the payload has none),
   *  and for the daemon its home, env and install (#619). */
  process: {
    cwd: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    self?: ForemanSelf;
    /** FOREMAN_SPAWNED_BY in the hook's environment: the instance Foreman
     *  launched Claude Code as (agent-instance.ts), if any. */
    spawnedBy?: string | null;
  };
  requestId?: string;
  /** Gets the approval service, so the daemon can cancel a pending
   *  approval when the hook process goes away. */
  onApproval?: (approval: DbApprovalService) => void;
}

const blocked = (text: string): HookVerdict => ({
  exit: HOOK_BLOCK,
  lines: [{ level: "error", text }],
});

/** Decide one PreToolUse payload. Never throws: every failure blocks. */
export async function evaluateHookPayload(
  raw: string,
  agentId: string,
  ev: HookEvaluation,
): Promise<HookVerdict> {
  try {
    return await evaluate(raw, agentId, ev);
  } catch (err) {
    return blocked(
      `could not evaluate the call (${err instanceof Error ? err.message : String(err)}) — blocking it. ` +
        "Run `foreman doctor` to diagnose.",
    );
  }
}

async function evaluate(raw: string, agentId: string, ev: HookEvaluation): Promise<HookVerdict> {
  if (!raw.trim()) return blocked("empty PreToolUse payload — blocking the call.");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return blocked(
      `could not parse the PreToolUse payload (${
        err instanceof Error ? err.message : String(err)
      }) — blocking the call.`,
    );
  }

  const adapter = getAdapter(ADAPTER_ID);
  if (!adapter) return blocked(`adapter ${ADAPTER_ID} is missing from this build — blocking the call.`);
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
    const cwd = typeof cwdField === "string" && cwdField.length > 0 ? cwdField : ev.process.cwd;
    if (
      isForemanServedTool(toolName, {
        cwd,
        hubConfigPath: ev.mcpConfigPath,
        ...(ev.process.home !== undefined ? { home: ev.process.home } : {}),
        ...(ev.process.env !== undefined ? { env: ev.process.env } : {}),
        ...(ev.process.self !== undefined ? { self: ev.process.self } : {}),
      })
    ) {
      return { exit: HOOK_ALLOW, lines: [] };
    }
  }
  let normalised;
  try {
    normalised = adapter.decodeRequest(payload, agentId);
  } catch (err) {
    const reason =
      err instanceof AdapterDecodeError || err instanceof Error ? err.message : String(err);
    return blocked(`malformed PreToolUse payload (${reason}) — blocking the call.`);
  }

  const { db, bus, flushAudit } = ev.open();
  const lines: HookLine[] = [];
  const approval = new DbApprovalService(db, { bus, timeoutMs: ev.timeoutMs });
  ev.onApproval?.(approval);
  const { mediator } = createMediatorStack({
    db,
    bus,
    approval,
    policyPath: ev.policyPath,
    onPolicyError: (message) => lines.push({ level: "info", text: message }),
  });
  const result = await mediator.handleRequest({
    ...(ev.requestId ? { requestId: ev.requestId } : {}),
    sourceAgent: hookSource(normalised.sourceAgent, ev.process.spawnedBy ?? null, new RegistryService(db, bus)),
    targetTool: normalised.targetTool,
    ...(normalised.sessionId ? { sessionId: normalised.sessionId } : {}),
    message: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: normalised.targetTool, arguments: normalised.args },
    } as JSONRPCMessage,
    policyFallback: { effect: "allow", source: "hook:risk-based" },
  });
  // The audit row lands before the agent learns the answer.
  flushAudit();
  if (result.decision === "allowed") {
    lines.push({
      level: "info",
      text: `${String(toolName)} allowed (${result.decidedBy}, risk ${result.riskScore}/100).`,
    });
    return { exit: HOOK_ALLOW, lines };
  }
  const role = result.decidedBy === "org:role" ? result.riskFactors.find((f) => f.rule === "org_role") : undefined;
  if (role) {
    // The role's limits, not a risk verdict: say which and where they're set.
    lines.push({ level: "error", text: `${String(toolName)} blocked by Foreman: ${role.reason}.` });
    return { exit: HOOK_BLOCK, lines };
  }
  const reasons = result.riskReasons.length > 0 ? `; ${result.riskReasons.join(", ")}` : "";
  lines.push({
    level: "error",
    text:
      `${String(toolName)} blocked by Foreman (${result.decidedBy}${reasons}, ` +
      `score ${result.riskScore}/100). Review with \`foreman log tail\`; adjust policy.yaml if this was expected.`,
  });
  return { exit: HOOK_BLOCK, lines };
}

export const hookCommand = new Command("hook")
  .description(
    "PreToolUse hook entrypoint. Wired from the agent's " +
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
    process.exit(HOOK_BLOCK);
  })
  .action(async (agentId: string, opts: { timeoutMs?: number }) => {
    installFailClosedHandlers();
    if (opts.timeoutMs !== undefined && !(Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0)) {
      blockHook("--timeout-ms must be a whole number of milliseconds — blocking the call.");
    }
    const timeoutMs = hookTimeoutMs(opts.timeoutMs);
    try {
      const raw = await readPayloadOrBlock();
      const viaDaemon = await hookViaDaemon(agentId, timeoutMs, raw);
      process.exit(viaDaemon ?? (await runHook(agentId, timeoutMs, raw)));
    } catch (err) {
      blockHook(
        `could not evaluate the call (${err instanceof Error ? err.message : String(err)}) — blocking it. ` +
          "Run `foreman doctor` to diagnose.",
      );
    }
  });

/** Anything that escapes a try/catch (a rejected promise inside a library
 *  callback, a synchronous throw from a listener) still blocks. The main
 *  CLI installs a handler that rethrows (exit 7, which Claude Code would
 *  treat as "run the tool"), so ours must be the only one. */
export function installFailClosedHandlers(): void {
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  process.on("uncaughtException", (err) =>
    blockHook(`internal error (${err.message}) — blocking the call`),
  );
  process.on("unhandledRejection", (err) =>
    blockHook(
      `internal error (${err instanceof Error ? err.message : String(err)}) — blocking the call`,
    ),
  );
}

export async function readPayloadOrBlock(): Promise<string> {
  try {
    return await readHookStdin();
  } catch (err) {
    blockHook(
      `could not read the PreToolUse payload (${
        err instanceof Error ? err.message : String(err)
      }) — blocking the call.`,
    );
  }
}

/** The in-process path: open the database, mediate here, close it. */
export async function runHook(agentId: string, timeoutMs: number, raw?: string): Promise<0 | 2> {
  const payload = raw ?? (await readPayloadOrBlock());
  const paths = getForemanPaths();
  let audit: AuditLogger | null = null;
  try {
    const verdict = await evaluateHookPayload(payload, agentId, {
      open: () => {
        const db = getDb();
        const logger = new AuditLogger(db, processBus);
        audit = logger;
        return { db, bus: processBus, flushAudit: () => logger.flush() };
      },
      policyPath: paths.policyPath,
      mcpConfigPath: paths.mcpConfigPath,
      timeoutMs,
      process: { cwd: process.cwd(), spawnedBy: process.env.FOREMAN_SPAWNED_BY ?? null },
    });
    writeHookLines(verdict.lines);
    return verdict.exit;
  } finally {
    if (audit) {
      (audit as AuditLogger).dispose();
      closeDb();
    }
  }
}

/**
 * Who a Claude Code tool call is from. The hook in settings.json names the
 * agent (`claude-code`), but Foreman launches an instance of it
 * (`reviewer --type claude-code`) with FOREMAN_SPAWNED_BY=reviewer: its
 * calls are that instance's, under its role. Only a registered instance of
 * this very agent counts; anything else stays the agent itself. The same
 * launch environment `foreman write` trusts (docs/org.md, Limits).
 */
export function hookSource(
  agentId: string,
  spawnedBy: string | null,
  registry: Pick<RegistryService, "get">,
): string {
  if (!spawnedBy || spawnedBy === agentId) return agentId;
  const instance = registry.get(spawnedBy);
  return instance?.metadata?.registryId === agentId ? spawnedBy : agentId;
}

