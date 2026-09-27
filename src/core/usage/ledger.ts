import { existsSync, statSync } from "node:fs";
import { monotonicFactory } from "ulid";
import type { ForemanDb } from "../../db/client.js";
import { agentUsage, type AgentUsage } from "../../db/schema.js";
import { loadOrg, rolesForAgent, type OrgDoc } from "../org/org.js";
import { estimateCost, type TokenCounts } from "./pricing.js";

// =============================================================================
// Usage ledger (#629) — every unit of agent model spend, attributed
// =============================================================================
//
// Writers: the OTLP receiver (telemetry from Claude Code / Codex), the task
// runner (usage lines an agent CLI printed) — see otlp-receiver.ts and
// task-usage.ts. Each row is tagged with the agent's role and department
// from org.yaml at the time it is written.

export type UsageSource = "telemetry" | "task-output" | "foreman";

export interface UsageEntry extends TokenCounts {
  agentId: string;
  source: UsageSource;
  model?: string | null;
  /** Cost the source reported. Omitted → estimated from the price table. */
  costUsd?: number | null;
  taskRef?: string | null;
  sessionRef?: string | null;
  ts?: number;
}

const nextId = monotonicFactory();

export interface Attribution {
  role: string | null;
  department: string | null;
}

export class UsageLedger {
  private org: { doc: OrgDoc | null; mtimeMs: number } | null = null;

  constructor(
    private readonly db: ForemanDb,
    private readonly opts: { orgConfigPath?: string; now?: () => number } = {},
  ) {}

  record(entry: UsageEntry): AgentUsage | null {
    const agentId = entry.agentId.trim().toLowerCase().slice(0, 64);
    const counts = {
      input: nonNegative(entry.input),
      output: nonNegative(entry.output),
      cacheRead: nonNegative(entry.cacheRead),
      cacheWrite: nonNegative(entry.cacheWrite),
      total: nonNegative(entry.total),
    };
    const tokens = counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
    const reported = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd) && entry.costUsd >= 0;
    if (!agentId || (tokens === 0 && counts.total === 0 && !reported)) return null;
    const estimated = reported ? null : estimateCost(entry.model, counts);
    const ts = entry.ts ?? (this.opts.now ?? Date.now)();
    const { role, department } = this.attribution(agentId);
    const row: AgentUsage = {
      id: nextId(ts),
      ts,
      agentId,
      role,
      department,
      source: entry.source,
      model: entry.model?.slice(0, 120) ?? null,
      inputTokens: counts.input,
      outputTokens: counts.output,
      cacheReadTokens: counts.cacheRead,
      cacheWriteTokens: counts.cacheWrite,
      totalTokens: counts.total > 0 ? counts.total : tokens,
      costUsd: Math.min(reported ? entry.costUsd! : (estimated ?? 0), MAX_COST_PER_RECORD),
      costEstimated: reported ? 0 : 1,
      taskRef: entry.taskRef?.slice(0, 64) ?? null,
      sessionRef: entry.sessionRef?.slice(0, 128) ?? null,
    };
    this.db.insert(agentUsage).values(row).run();
    return row;
  }

  /** The agent's first role in org.yaml, and that role's department. */
  attribution(agentId: string): Attribution {
    const doc = this.orgDoc();
    if (!doc) return { role: null, department: null };
    const role = rolesForAgent(doc, agentId)[0] ?? null;
    return { role, department: role ? (doc.roles[role]?.department ?? null) : null };
  }

  private orgDoc(): OrgDoc | null {
    const path = this.opts.orgConfigPath;
    if (!path || !existsSync(path)) return null;
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (!this.org || this.org.mtimeMs !== mtimeMs) this.org = { doc: loadOrg(path), mtimeMs };
      return this.org.doc;
    } catch {
      // An org.yaml that doesn't parse: record without attribution.
      return null;
    }
  }
}

/** Upper bounds for one record: far above any real request, low enough
 *  that a bogus report can't produce absurd totals. */
const MAX_TOKENS_PER_RECORD = 50_000_000;
const MAX_COST_PER_RECORD = 100;

function nonNegative(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_TOKENS_PER_RECORD) : 0;
}
