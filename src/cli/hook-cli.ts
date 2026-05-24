import { Command } from "commander";
import { ulid } from "ulid";
import { DbApprovalService } from "../core/approval.js";
import { bus } from "../core/event-bus.js";
import { RiskScorer } from "../core/risk-scorer.js";
import { closeDb, getDb } from "../db/client.js";
import { red, dim } from "./colors.js";

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
//   1. Parses the payload.
//   2. Risk-scores it (re-uses the existing RiskScorer + every rule shipped
//      with Foreman — `shell_destructive`, `secret_path`, etc.).
//   3. Inserts a pending_approvals row + polls until the user decides
//      (or the deadline auto-denies). Same DB-backed bridge the MCP
//      mediator uses, so the approval surfaces in the TUI modal + on
//      Telegram via the existing #522 inline keyboards.
//   4. Exits 0 (allow) or 2 (block) per Claude Code's hook contract.
//
// The hook is intentionally a separate CLI command from `mcp-stdio` so a
// crashed Foreman daemon doesn't take down the agent's whole tool stack
// — each invocation is self-contained, opens its own DB handle, and
// closes it on exit. Hooks run every tool call so the cold-start is
// kept tight (no orchestrator-chat init, no notification channel setup).

interface ClaudeHookPayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Read the whole stdin into a single string. Claude Code hooks pass
 *  a one-shot JSON object then close stdin; this resolves on EOF. */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
    // Defensive: a hook script with no stdin payload should still exit
    // cleanly (e.g. operator runs `foreman hook claude-code` by hand to
    // sanity-check the binary works) — Node won't fire `end` until
    // stdin closes; if Claude already closed it before we attached, the
    // listener attached above STILL fires the buffered `end`.
  });
}

export const hookCommand = new Command("hook")
  .description(
    "PreToolUse hook entrypoint (#517 Faz 4). Wired from the agent's " +
      "settings file by `foreman agent hook install <agent>`. Reads the " +
      "agent's tool-call payload from stdin, scores + gates the call via " +
      "Foreman's approval pipeline, and exits 0 (allow) / 2 (block).",
  )
  .argument(
    "<agentId>",
    "Agent id whose tool call is being gated (`claude-code` today).",
  )
  .option(
    "--timeout-ms <ms>",
    "How long to wait for the user's decision before defaulting to block",
    (v) => Number.parseInt(v, 10),
    600_000,
  )
  .action(async (agentId: string, opts: { timeoutMs: number }) => {
    let raw: string;
    try {
      raw = await readStdin();
    } catch (err) {
      // No stdin = nothing to gate. Exit 0 so the hook doesn't block the
      // call (defensive — better to under-block than to surprise-deny).
      process.stderr.write(
        `${red("foreman hook:")} could not read stdin (${
          err instanceof Error ? err.message : String(err)
        }) — defaulting to allow.\n`,
      );
      process.exit(0);
    }
    if (!raw.trim()) {
      process.exit(0);
    }
    let payload: ClaudeHookPayload;
    try {
      payload = JSON.parse(raw) as ClaudeHookPayload;
    } catch (err) {
      process.stderr.write(
        `${red("foreman hook:")} could not parse PreToolUse payload (${
          err instanceof Error ? err.message : String(err)
        }) — defaulting to allow.\n`,
      );
      process.exit(0);
    }
    const toolName = payload.tool_name;
    const args = payload.tool_input ?? {};
    const sessionId = payload.session_id;
    if (!toolName) {
      process.stderr.write(
        `${red("foreman hook:")} payload has no tool_name — defaulting to allow.\n`,
      );
      process.exit(0);
    }

    const db = getDb();
    const risk = new RiskScorer(db);
    const requestId = ulid();
    const assessment = risk.assess({
      sourceAgent: agentId,
      targetTool: toolName,
      args,
      ...(sessionId ? { sessionId } : {}),
    });

    // Low-risk calls (risk < 30 → 'low' bucket → 'allow' recommendation)
    // pass through without bothering the user. The audit log still
    // captures them via the mediator path if any.
    if (assessment.recommendation === "allow") {
      process.stderr.write(
        `${dim("foreman hook:")} ${toolName} risk ${assessment.totalScore}/100 — allowed without prompt.\n`,
      );
      closeDb();
      process.exit(0);
    }

    // 'deny' from the risk scorer auto-blocks without asking.
    if (assessment.recommendation === "deny") {
      const reason = assessment.factors.map((f) => f.rule).join(", ") || "high-risk";
      process.stderr.write(
        `${red("foreman hook:")} ${toolName} blocked by Foreman (${reason}, ` +
          `score ${assessment.totalScore}/100). Adjust policy.yaml or run ` +
          `\`foreman agent trust ${agentId}\` to skip the hook entirely.\n`,
      );
      closeDb();
      process.exit(2);
    }

    // 'ask' — round-trip to the user via the DB approval bridge.
    const approval = new DbApprovalService(db, {
      bus,
      timeoutMs: opts.timeoutMs,
    });
    const decision = await approval.request({
      requestId,
      sourceAgent: agentId,
      targetTool: toolName,
      args,
      riskScore: assessment.totalScore,
      riskReasons: assessment.factors.map((f) => f.rule),
      riskFactors: assessment.factors,
      riskBucket: assessment.bucket,
      llmVerification: null,
      securityReport: null,
      ...(sessionId ? { sessionId } : {}),
    });
    closeDb();
    if (decision.decision === "allowed") {
      process.exit(0);
    }
    process.stderr.write(
      `${red("foreman hook:")} ${toolName} denied by user (${
        decision.via ?? "approval"
      }).\n`,
    );
    process.exit(2);
  });
