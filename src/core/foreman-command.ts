import { existsSync } from "node:fs";
import type { ForemanDb } from "../db/client.js";
import { readForemanPid } from "./foreman-pidfile.js";
import { getBudgetStatus } from "./llm/budget.js";
import {
  defaultLlmConfig,
  isFeatureEnabled,
  loadLlmConfig,
  type LlmConfig,
} from "./llm/config.js";
import type { RegistryService } from "./registry.js";

// =============================================================================
// Foreman command router (#431)
// =============================================================================
//
// User types `/foreman <verb> [args...]` into whichever agent's chat they
// have open. The agent's getUpdates consumer (sole consumer on the bot
// per yol C — see project_foreman_scope_yol_c.md) sees the literal slash
// command and routes it via the `submit_command` MCP tool. This router
// dispatches the verb to a built-in handler and returns a text reply
// the agent then posts back as a Telegram message.
//
// All handlers shipped in this PR are read-only — they execute fully
// inside the MCP-stdio process without needing cross-process signalling
// to `foreman start`. Cross-process commands (`stop`, `llm switch`,
// `write <agent>`) ship in follow-up issue #440.

export interface ForemanCommandContext {
  db: ForemanDb;
  registry: RegistryService;
  /** Path to `llm.yaml` so handlers can read the current Foreman LLM
   *  config + budget without hardcoding the location. */
  llmConfigPath: string;
  /** Foreman's `<configDir>` — used by the stop handler to locate the
   *  pidfile written by `foreman start`. */
  configDir: string;
  /** Agent id that routed the user's command (mirrors `submit_approval`
   *  pattern). Used for the audit log + future per-agent gating. */
  sourceAgent: string;
  /** Optional user identifier from the messaging platform (Telegram
   *  numeric user id, Discord snowflake, …) for audit traceability. */
  sourceUser?: string;
}

export interface ForemanCommandResult {
  ok: boolean;
  /** Text body to send back to the user. Multi-line is fine; channels
   *  fit ~4000 chars on Telegram, less on Discord. Keep replies tight. */
  text: string;
  /** Stable code for failures so callers can branch on category. */
  errorCode?: "UNKNOWN_COMMAND" | "UNKNOWN_SUBCOMMAND" | "NOT_AUTHORIZED" | "NOT_AVAILABLE";
}

export type ForemanCommandHandler = (
  args: string[],
  ctx: ForemanCommandContext,
) => Promise<ForemanCommandResult> | ForemanCommandResult;

export class ForemanCommandRouter {
  private readonly handlers = new Map<string, ForemanCommandHandler>();
  private readonly descriptions = new Map<string, string>();

  register(
    verb: string,
    handler: ForemanCommandHandler,
    description: string,
  ): void {
    const key = verb.toLowerCase();
    this.handlers.set(key, handler);
    this.descriptions.set(key, description);
  }

  listVerbs(): Array<{ verb: string; description: string }> {
    return [...this.descriptions.entries()].map(([verb, description]) => ({
      verb,
      description,
    }));
  }

  async dispatch(
    command: string,
    args: string[],
    ctx: ForemanCommandContext,
  ): Promise<ForemanCommandResult> {
    const handler = this.handlers.get(command.toLowerCase());
    if (!handler) {
      return {
        ok: false,
        text:
          `Unknown command "${command}". Try \`/foreman help\` for the list.`,
        errorCode: "UNKNOWN_COMMAND",
      };
    }
    return await handler(args, ctx);
  }
}

// =============================================================================
// Built-in handlers
// =============================================================================

export function registerBuiltinCommands(router: ForemanCommandRouter): void {
  router.register(
    "help",
    (_args, _ctx) => buildHelpReply(router),
    "List every /foreman command + its purpose.",
  );
  router.register(
    "status",
    statusHandler,
    "One-line summary — registered agents, runtime status, Foreman build version.",
  );
  router.register(
    "stop",
    stopHandler,
    "Gracefully shut down `foreman start` + every agent daemon it owns.",
  );
  router.register(
    "llm",
    llmSubrouterHandler,
    "Inspect / manage Foreman's own LLM. Try `/foreman llm status`.",
  );
}

function buildHelpReply(router: ForemanCommandRouter): ForemanCommandResult {
  const lines: string[] = ["Foreman commands:"];
  for (const v of router.listVerbs()) {
    lines.push(`  /foreman ${v.verb.padEnd(8)}  ${v.description}`);
  }
  lines.push("");
  lines.push("(case-insensitive — anything not in this list returns an error.)");
  return { ok: true, text: lines.join("\n") };
}

function statusHandler(
  _args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  const agents = ctx.registry.listAll();
  const active = agents.filter((a) => a.status === "active").length;
  const blocked = agents.filter((a) => a.status === "blocked").length;
  const disabled = agents.filter((a) => a.status === "disabled").length;
  const lines: string[] = [
    `Foreman v0.1.x — ${agents.length} agent${agents.length === 1 ? "" : "s"} registered`,
    `  ${active} active · ${blocked} blocked · ${disabled} disabled`,
  ];
  if (agents.length > 0) {
    lines.push("");
    lines.push("Agents:");
    for (const a of agents.slice(0, 10)) {
      const flag =
        a.status === "active"
          ? "●"
          : a.status === "blocked"
            ? "✗"
            : a.status === "disabled"
              ? "○"
              : "·";
      const lastSeen = a.lastSeenAt
        ? `last ${describeAgo(Date.now() - a.lastSeenAt)}`
        : "never";
      lines.push(`  ${flag} ${a.id} — ${lastSeen}`);
    }
    if (agents.length > 10) lines.push(`  … and ${agents.length - 10} more`);
  }
  return { ok: true, text: lines.join("\n") };
}

function stopHandler(
  _args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  const pid = readForemanPid(ctx.configDir);
  if (pid === null) {
    return {
      ok: false,
      text:
        "Foreman start isn't running (no pidfile or stale PID). " +
        "If you think it is, check `ps aux | grep foreman` on the host.",
      errorCode: "NOT_AVAILABLE",
    };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    return {
      ok: false,
      text:
        `Failed to signal Foreman PID ${pid}: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "NOT_AVAILABLE",
    };
  }
  return {
    ok: true,
    text:
      `Shutting down Foreman (PID ${pid}). ` +
      `Agent daemons will receive SIGTERM and exit within ~5s.`,
  };
}

function llmSubrouterHandler(
  args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "status") return llmStatusHandler(args.slice(1), ctx);
  if (sub === "switch" || sub === "budget") {
    return {
      ok: false,
      text:
        `\`/foreman llm ${sub}\` requires cross-process control — coming in a follow-up release. ` +
        `For now, run \`foreman llm ${sub} ...\` from the CLI on the Foreman host.`,
      errorCode: "NOT_AVAILABLE",
    };
  }
  return {
    ok: false,
    text:
      `Unknown llm subcommand "${sub}". Available: \`/foreman llm status\`.`,
    errorCode: "UNKNOWN_SUBCOMMAND",
  };
}

function llmStatusHandler(
  _args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  const config: LlmConfig = existsSync(ctx.llmConfigPath)
    ? loadLlmConfig(ctx.llmConfigPath)
    : defaultLlmConfig();
  if (!config.enabled) {
    return {
      ok: true,
      text:
        "Foreman LLM is **disabled** (heuristics only). Enable via `foreman llm enable` on the host.",
    };
  }
  const status = getBudgetStatus(ctx.db, config);
  const features = [
    isFeatureEnabled(config, "verification") ? "verification ✓" : null,
    isFeatureEnabled(config, "smart_report") ? "smart_report ✓" : null,
    isFeatureEnabled(config, "policy_suggestions") ? "policy_suggestions ✓" : null,
  ].filter((s): s is string => s !== null);
  const lines = [
    `Foreman LLM: ${config.provider} — ${config.model}`,
    `Budget: $${status.spentUsd.toFixed(2)} / $${status.capUsd.toFixed(2)} (${status.spentPct.toFixed(0)}%)`,
  ];
  if (features.length > 0) {
    lines.push(`Features: ${features.join(" · ")}`);
  }
  return { ok: true, text: lines.join("\n") };
}

// Compact "Xs / Xm / Xh ago" rendering — keeps Telegram replies tight.
function describeAgo(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
