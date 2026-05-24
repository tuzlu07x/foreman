import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ForemanDb } from "../db/client.js";
import { policies, requests } from "../db/schema.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";

export type Effect = "allow" | "deny" | "ask";

export interface EvaluateRequest {
  sourceAgent: string;
  targetAgent?: string;
  targetTool?: string;
  args?: unknown;
}

export interface Evaluation {
  decision: Effect;
  matchedRuleId?: number;
}

export interface RuleConditions {
  /** Rule applies only when `args.path` matches one of these regex patterns. */
  pathMatch?: string[];
  /** Rule applies only when `args.command` (or first array element) contains one of these substrings. */
  commandMatch?: string[];
  /** Rule does NOT apply when `args.path` matches this regex. */
  pathNotMatch?: string;
  /** #526 — Rule applies only when the target tool name matches this regex.
   *  Lets a user say "block all `read_*` tools from hermes" with one rule
   *  instead of one per tool. */
  toolPattern?: string;
  /** #526 — Rule applies only when ANY string arg value contains this
   *  case-insensitive substring. Used by the "block any call referencing
   *  pastebin.com" pattern the approval modal can offer. */
  argContains?: string;
  rateLimits?: {
    messagesPerMinute?: number;
    tokensPerHour?: number;
  };
  /** #526 — Provenance stamp for rules injected by Foreman from an
   *  approval modal action. `source: { kind: "user" }` is implicit for
   *  hand-edited YAML rules; this block is populated when the rule
   *  came from `addPredicateRule()`. */
  source?: PolicyRuleSource;
}

/** #526 — Provenance metadata embedded on a rule's `conditions.source`.
 *  Lets `foreman policy list` (and the audit log) say "this rule was
 *  added by Foreman from approval abc123" instead of looking like it
 *  appeared out of nowhere. */
export interface PolicyRuleSource {
  kind: "user" | "approval";
  /** Stable id of the approval row that triggered the rule injection.
   *  Cross-references the audit log entry. */
  approvalId?: string;
  /** Unix ms when the rule was added. */
  addedAt: number;
  /** Short human-language reason — typically the risk factor that the
   *  user blocked (e.g. "secret_file_pattern_env"). Surfaces in the
   *  policy.yaml comment block + `foreman policy list`. */
  reason?: string;
}

export interface RememberInput {
  sourceAgent: string;
  target: string;
  effect: Effect;
  conditions?: RuleConditions;
}

const PolicyRuleSourceSchema: z.ZodType<PolicyRuleSource> = z
  .object({
    kind: z.enum(["user", "approval"]),
    approvalId: z.string().optional(),
    addedAt: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })
  .strict();

const RuleConditionsSchema: z.ZodType<RuleConditions> = z
  .object({
    pathMatch: z.array(z.string()).optional(),
    commandMatch: z.array(z.string()).optional(),
    pathNotMatch: z.string().optional(),
    toolPattern: z.string().optional(),
    argContains: z.string().optional(),
    rateLimits: z
      .object({
        messagesPerMinute: z.number().int().positive().optional(),
        tokensPerHour: z.number().int().positive().optional(),
      })
      .optional(),
    source: PolicyRuleSourceSchema.optional(),
  })
  .strict();

const RulesArrayItemSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  effect: z.enum(["allow", "deny", "ask"]),
  conditions: RuleConditionsSchema.optional(),
});

const AgentEntrySchema = z
  .object({
    can_call: z.record(z.string(), z.array(z.string())).optional(),
    cannot_call: z.record(z.string(), z.array(z.string())).optional(),
    can_access_secrets: z.array(z.string()).optional(),
    cannot_access_secrets: z.array(z.string()).optional(),
    rate_limits: z
      .object({
        messages_per_minute: z.number().int().positive().optional(),
        tokens_per_hour: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

// Optional per-bucket recommendation override for the C1 factor model.
// Lets a user pin "deny critical" or relax "ask medium" → "allow" once
// they've reviewed the false-positive rate in their environment.
const BucketOverridesSchema = z
  .object({
    low: z.enum(["allow", "ask", "deny"]).optional(),
    medium: z.enum(["allow", "ask", "deny"]).optional(),
    high: z.enum(["allow", "ask", "deny"]).optional(),
    critical: z.enum(["allow", "ask", "deny"]).optional(),
  })
  .strict();

// Responsibility-based policy (#299) — orthogonal to the existing
// agent-level rules. Lets users say "agents with responsibility X cannot
// access these paths / call agents with responsibility Y / use these
// services". The risk rule that consumes this lives in #300.
const ResponsibilityPolicySchema = z
  .object({
    /** Human-readable role this rule applies to. Compared case-insensitively
     *  against the agent's `responsibilityNote`. */
    responsibility: z.string().min(1),
    /** Glob/regex strings — paths the agent must not read or write. */
    cannot_access: z.array(z.string()).optional(),
    /** Other-agent responsibilities this agent IS allowed to delegate to. */
    can_call_agents_with_responsibility: z.array(z.string()).optional(),
    /** Other-agent responsibilities this agent must NOT delegate to. */
    cannot_call_agents_with_responsibility: z.array(z.string()).optional(),
    /** Service ids (telegram, github, jira, etc.) the agent IS allowed to
     *  use. When set, services NOT in this list are denied. When omitted,
     *  no service restriction. */
    can_use_services: z.array(z.string()).optional(),
  })
  .strict();

export type ResponsibilityPolicy = z.infer<typeof ResponsibilityPolicySchema>;

// #529 — Session enforcement limits. `token_limit` is the hard halt boundary
// SessionManager checks every turn (mirrors the existing turn-limit pattern).
// `token_budget_warning_pct` is the advisory threshold the loop-detection
// risk rule uses to surface a "session is filling up" factor before the halt
// itself fires. Both default to the prior hardcoded values (100K / 80%) so
// deployments without `session_limits:` in policy.yaml keep working.
const SessionLimitsSchema = z
  .object({
    token_limit: z.number().int().positive().optional(),
    token_budget_warning_pct: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export interface SessionLimits {
  tokenLimit: number;
  tokenBudgetWarningPct: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  tokenLimit: 100_000,
  tokenBudgetWarningPct: 80,
};

const PolicyDocSchema = z
  .object({
    agents: z.record(z.string(), AgentEntrySchema).optional(),
    rules: z.array(RulesArrayItemSchema).optional(),
    buckets: BucketOverridesSchema.optional(),
    responsibility_policies: z.array(ResponsibilityPolicySchema).optional(),
    session_limits: SessionLimitsSchema.optional(),
  })
  .strict();

export type BucketOverrides = z.infer<typeof BucketOverridesSchema>;

const EFFECT_ORDER: Record<Effect, number> = { deny: 0, allow: 1, ask: 2 };

export class PolicyRuleNotFoundError extends Error {
  constructor(public readonly ruleId: number) {
    super(`Policy rule not found: ${ruleId}`);
    this.name = "PolicyRuleNotFoundError";
  }
}

export class PolicyEngine {
  // Held in memory only — re-populated on every loadYamlText. The mediator
  // reads via getBucketOverrides() each call so a YAML reload takes effect
  // without a restart.
  private bucketOverrides: BucketOverrides = {};
  // Responsibility-based policy (#299). Consumed by the responsibility
  // violation risk rule (#300, separate PR). The mediator reads via
  // getResponsibilityPolicies() per call so a YAML reload takes effect
  // without a restart.
  private responsibilityPolicies: ResponsibilityPolicy[] = [];
  // #529 — Session enforcement limits. Read by SessionManager (halt
  // boundary) + the loop-detection rule (advisory warning). Per-call
  // accessor so YAML reload applies without a restart.
  private sessionLimits: SessionLimits = { ...DEFAULT_SESSION_LIMITS };

  constructor(
    private readonly db: ForemanDb,
    private readonly bus: EventBus<ForemanEventMap> = defaultBus,
  ) {}

  loadFromYaml(path: string): { rulesAdded: number } {
    return this.loadYamlText(readFileSync(path, "utf-8"));
  }

  // Replaces every previously-yaml-loaded rule with the doc's contents.
  // The swap runs inside a single transaction so concurrent evaluators
  // never observe the empty-policy window mid-reload.
  loadYamlText(text: string): { rulesAdded: number } {
    const parsed = parseYaml(text);
    const doc = parsed === null ? {} : PolicyDocSchema.parse(parsed);
    const now = Date.now();
    this.bucketOverrides = doc.buckets ?? {};
    this.responsibilityPolicies = doc.responsibility_policies ?? [];
    // #529 — Merge with defaults so a partial `session_limits:` block (only
    // `token_limit:` set) keeps the warning pct at 80 instead of becoming
    // undefined. Omitting the block entirely also restores defaults — a
    // hot reload that removes the override goes back to 100K / 80%.
    const sl = doc.session_limits;
    this.sessionLimits = {
      tokenLimit: sl?.token_limit ?? DEFAULT_SESSION_LIMITS.tokenLimit,
      tokenBudgetWarningPct:
        sl?.token_budget_warning_pct ??
        DEFAULT_SESSION_LIMITS.tokenBudgetWarningPct,
    };

    const rows: (typeof policies.$inferInsert)[] = [];
    for (const [agentId, entry] of Object.entries(doc.agents ?? {})) {
      for (const [target, methods] of Object.entries(entry.can_call ?? {})) {
        for (const method of methods) {
          rows.push(
            this.makeRow(agentId, `${target}:${method}`, "allow", null, now),
          );
        }
      }
      for (const [target, methods] of Object.entries(entry.cannot_call ?? {})) {
        for (const method of methods) {
          rows.push(
            this.makeRow(agentId, `${target}:${method}`, "deny", null, now),
          );
        }
      }
      for (const secretName of entry.can_access_secrets ?? []) {
        rows.push(
          this.makeRow(agentId, secretTarget(secretName), "allow", null, now),
        );
      }
      for (const secretName of entry.cannot_access_secrets ?? []) {
        rows.push(
          this.makeRow(agentId, secretTarget(secretName), "deny", null, now),
        );
      }
      if (entry.rate_limits) {
        const cond: RuleConditions = {
          rateLimits: {
            messagesPerMinute: entry.rate_limits.messages_per_minute,
            tokensPerHour: entry.rate_limits.tokens_per_hour,
          },
        };
        rows.push(this.makeRow(agentId, "*", "ask", JSON.stringify(cond), now));
      }
    }
    for (const r of doc.rules ?? []) {
      rows.push(
        this.makeRow(
          r.source,
          r.target,
          r.effect,
          r.conditions ? JSON.stringify(r.conditions) : null,
          now,
        ),
      );
    }

    this.db.transaction((tx) => {
      tx.delete(policies).where(eq(policies.createdBy, "user")).run();
      if (rows.length > 0) {
        tx.insert(policies).values(rows).run();
      }
    });
    return { rulesAdded: rows.length };
  }

  // Secret access is deny-by-default. Only an explicit allow rule grants access;
  // anything else (no rule, conflicting rule, missing entry) denies.
  evaluateSecretAccess(
    sourceAgent: string,
    secretName: string,
  ): Evaluation & { decidedBy: string } {
    const target = secretTarget(secretName);
    const candidates = this.db
      .select()
      .from(policies)
      .where(
        and(
          inArray(policies.sourceAgent, [sourceAgent, "*"]),
          eq(policies.target, target),
          eq(policies.enabled, 1),
        ),
      )
      .all();

    candidates.sort((a, b) => {
      const aExact = a.sourceAgent === sourceAgent ? 0 : 1;
      const bExact = b.sourceAgent === sourceAgent ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return EFFECT_ORDER[a.effect] - EFFECT_ORDER[b.effect];
    });

    const winner = candidates[0];
    if (winner && winner.effect === "allow") {
      return {
        decision: "allow",
        matchedRuleId: winner.id,
        decidedBy: `policy:${winner.id}`,
      };
    }
    if (winner && winner.effect === "deny") {
      return {
        decision: "deny",
        matchedRuleId: winner.id,
        decidedBy: `policy:cannot_access_secrets`,
      };
    }
    return { decision: "deny", decidedBy: "policy:deny-by-default" };
  }

  evaluate(req: EvaluateRequest): Evaluation {
    const target = this.requestTarget(req);
    if (!target) return { decision: "ask" };

    const rateLimitDecision = this.checkRateLimits(req);
    if (rateLimitDecision) return rateLimitDecision;

    const candidates = this.db
      .select()
      .from(policies)
      .where(
        and(
          inArray(policies.sourceAgent, [req.sourceAgent, "*"]),
          eq(policies.target, target),
          eq(policies.enabled, 1),
        ),
      )
      .all();

    candidates.sort((a, b) => {
      const aExact = a.sourceAgent === req.sourceAgent ? 0 : 1;
      const bExact = b.sourceAgent === req.sourceAgent ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      // Conditional rules win over conditionless ones — a path-pattern `ask`
      // must be evaluated before a blanket `allow` on the same target.
      const aSpec = a.conditions ? 0 : 1;
      const bSpec = b.conditions ? 0 : 1;
      if (aSpec !== bSpec) return aSpec - bSpec;
      return EFFECT_ORDER[a.effect] - EFFECT_ORDER[b.effect];
    });

    for (const rule of candidates) {
      if (this.conditionsPass(rule, req)) {
        return { decision: rule.effect, matchedRuleId: rule.id };
      }
    }
    return { decision: "ask" };
  }

  remember(input: RememberInput): number {
    const now = Date.now();
    const result = this.db
      .insert(policies)
      .values({
        sourceAgent: input.sourceAgent,
        target: input.target,
        effect: input.effect,
        conditions: input.conditions ? JSON.stringify(input.conditions) : null,
        createdAt: now,
        createdBy: "remember-action",
        enabled: 1,
      })
      .run();
    const ruleId = Number(result.lastInsertRowid);
    this.bus.emit("policy:changed", {
      ruleId,
      sourceAgent: input.sourceAgent,
      target: input.target,
      effect: input.effect,
      createdBy: "remember-action",
      changedAt: now,
    });
    return ruleId;
  }

  /** #526 — Inject a predicate-based deny rule from an approval modal action.
   *  Persists to the policies table + (best-effort) appends to policy.yaml
   *  with a provenance comment block so the user can see / edit / delete
   *  the rule later. Returns the rule id so the caller can echo it back to
   *  the user.
   *
   *  Why this is separate from `remember`:
   *  - `remember` is identity-based (this exact source → this exact target).
   *    The credential-leak case needs predicate-based ("any `.env*` read by
   *    hermes"), which `remember` can't express.
   *  - `addPredicateRule` always stamps `source: { kind: 'approval', … }`
   *    so the rule's origin is traceable in audits + the modal can later
   *    offer "remove this rule" tied to the same approvalId.
   */
  addPredicateRule(input: AddPredicateRuleInput): number {
    const now = Date.now();
    const conditions: RuleConditions = {
      ...(input.predicate.pathMatch ? { pathMatch: input.predicate.pathMatch } : {}),
      ...(input.predicate.toolPattern
        ? { toolPattern: input.predicate.toolPattern }
        : {}),
      ...(input.predicate.argContains
        ? { argContains: input.predicate.argContains }
        : {}),
      source: {
        kind: "approval",
        approvalId: input.approvalId,
        addedAt: now,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    };
    const result = this.db
      .insert(policies)
      .values({
        sourceAgent: input.sourceAgent,
        target: input.target,
        effect: "deny",
        conditions: JSON.stringify(conditions),
        createdAt: now,
        createdBy: "remember-action",
        enabled: 1,
      })
      .run();
    const ruleId = Number(result.lastInsertRowid);
    this.bus.emit("policy:changed", {
      ruleId,
      sourceAgent: input.sourceAgent,
      target: input.target,
      effect: "deny",
      createdBy: "remember-action",
      changedAt: now,
    });
    // Best-effort YAML append — if the caller passed a path we keep the
    // file in sync so the next `loadFromYaml` doesn't lose the rule, AND
    // the user can grep / edit / delete by hand. Failure to write is
    // logged-only; the DB insert already happened so the rule is live.
    if (input.policyYamlPath) {
      try {
        appendApprovalRuleToYaml(input.policyYamlPath, input, now);
      } catch {
        // best-effort; DB persistence is the source of truth
      }
    }
    return ruleId;
  }

  list(): (typeof policies.$inferSelect)[] {
    return this.db.select().from(policies).all();
  }

  getBucketOverrides(): BucketOverrides {
    return { ...this.bucketOverrides };
  }

  // Snapshot of the responsibility-policy block from the most recent YAML
  // load (#299). The #300 risk rule reads this every call so a YAML reload
  // takes effect without a process restart. Returns a shallow copy so the
  // caller can't mutate engine state.
  getResponsibilityPolicies(): ResponsibilityPolicy[] {
    return this.responsibilityPolicies.map((p) => ({ ...p }));
  }

  /** #529 — Snapshot of the session_limits block from the most recent YAML
   *  load. `SessionManager` reads `tokenLimit` per `recordTurn` and the
   *  loop-detection rule reads `tokenBudgetWarningPct` per assess() so a
   *  YAML reload takes effect mid-session. Returns a shallow copy so
   *  callers can't mutate engine state by accident. */
  getSessionLimits(): SessionLimits {
    return { ...this.sessionLimits };
  }

  setEnabled(ruleId: number, enabled: boolean): void {
    const row = this.db
      .select()
      .from(policies)
      .where(eq(policies.id, ruleId))
      .get();
    if (!row) throw new PolicyRuleNotFoundError(ruleId);
    this.db
      .update(policies)
      .set({ enabled: enabled ? 1 : 0 })
      .where(eq(policies.id, ruleId))
      .run();
    this.bus.emit("policy:changed", {
      ruleId,
      sourceAgent: row.sourceAgent,
      target: row.target,
      effect: row.effect,
      createdBy: row.createdBy,
      changedAt: Date.now(),
    });
  }

  private requestTarget(req: EvaluateRequest): string | null {
    if (req.targetAgent && req.targetTool) {
      return `${req.targetAgent}:${req.targetTool}`;
    }
    if (req.targetTool) return `tool:${req.targetTool}`;
    return null;
  }

  private conditionsPass(
    rule: typeof policies.$inferSelect,
    req: EvaluateRequest,
  ): boolean {
    if (!rule.conditions) return true;
    const cond = this.parseConditions(rule.conditions);
    if (!cond) return true;
    if (cond.pathNotMatch) {
      const path = this.extractPath(req.args);
      if (path && new RegExp(cond.pathNotMatch).test(path)) return false;
    }
    if (cond.pathMatch && cond.pathMatch.length > 0) {
      const path = this.extractPath(req.args);
      if (!path) return false;
      const hit = cond.pathMatch.some((p) => safeRegexTest(p, path));
      if (!hit) return false;
    }
    if (cond.commandMatch && cond.commandMatch.length > 0) {
      const command = this.extractCommand(req.args);
      if (!command) return false;
      const hit = cond.commandMatch.some((sub) => command.includes(sub));
      if (!hit) return false;
    }
    // #526 — toolPattern: rule applies when the request's targetTool matches
    // the regex. AND'd with the other predicates so a "block all read_* on
    // hermes" rule narrows by tool while leaving path matching open.
    if (cond.toolPattern) {
      if (!req.targetTool || !safeRegexTest(cond.toolPattern, req.targetTool)) {
        return false;
      }
    }
    // #526 — argContains: case-insensitive substring across all string
    // values in args. The "block any call mentioning pastebin.com" pattern
    // hits exfil heuristics that don't fit pathMatch.
    if (cond.argContains) {
      const haystack = this.extractArgStrings(req.args).toLowerCase();
      if (!haystack.includes(cond.argContains.toLowerCase())) return false;
    }
    return true;
  }

  /** #526 — Flatten every string-valued arg into a single haystack for
   *  the `argContains` predicate. Order-stable so a regex over the result
   *  would be deterministic (we use a substring check though). */
  private extractArgStrings(args: unknown): string {
    if (args === null || args === undefined) return "";
    if (typeof args === "string") return args;
    if (typeof args !== "object") return String(args);
    const parts: string[] = [];
    const walk = (value: unknown): void => {
      if (value === null || value === undefined) return;
      if (typeof value === "string") {
        parts.push(value);
        return;
      }
      if (typeof value !== "object") {
        parts.push(String(value));
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    };
    walk(args);
    return parts.join(" ");
  }

  private extractCommand(args: unknown): string | null {
    if (typeof args !== "object" || args === null) return null;
    const obj = args as { command?: unknown; args?: unknown };
    if (typeof obj.command === "string") {
      if (Array.isArray(obj.args)) {
        return [obj.command, ...obj.args.map(String)].join(" ");
      }
      return obj.command;
    }
    if (Array.isArray(obj.command)) {
      return obj.command.map(String).join(" ");
    }
    return null;
  }

  private checkRateLimits(req: EvaluateRequest): Evaluation | null {
    const rules = this.db
      .select()
      .from(policies)
      .where(
        and(
          inArray(policies.sourceAgent, [req.sourceAgent, "*"]),
          eq(policies.enabled, 1),
        ),
      )
      .all();

    for (const rule of rules) {
      if (!rule.conditions) continue;
      const cond = this.parseConditions(rule.conditions);
      const limit = cond?.rateLimits?.messagesPerMinute;
      if (!limit) continue;

      const since = Date.now() - 60_000;
      const row = this.db
        .select({ count: sql<number>`count(*)` })
        .from(requests)
        .where(
          and(
            eq(requests.sourceAgent, req.sourceAgent),
            gte(requests.createdAt, since),
          ),
        )
        .get();
      if ((row?.count ?? 0) >= limit) {
        return { decision: "deny", matchedRuleId: rule.id };
      }
    }
    return null;
  }

  private parseConditions(json: string): RuleConditions | null {
    try {
      return JSON.parse(json) as RuleConditions;
    } catch {
      return null;
    }
  }

  private extractPath(args: unknown): string | null {
    if (typeof args !== "object" || args === null) return null;
    const path = (args as { path?: unknown }).path;
    return typeof path === "string" ? path : null;
  }

  private makeRow(
    sourceAgent: string,
    target: string,
    effect: Effect,
    conditions: string | null,
    createdAt: number,
  ): typeof policies.$inferInsert {
    return {
      sourceAgent,
      target,
      effect,
      conditions,
      createdAt,
      createdBy: "user",
      enabled: 1,
    };
  }
}

export function secretTarget(secretName: string): string {
  return `secret:${secretName}`;
}

/** #526 — Predicate descriptor for `addPredicateRule`. Mirrors the
 *  user-facing fields the approval modal proposes via its custom
 *  ChannelAction button. All three predicate fields are optional; at
 *  least one must be set or the rule would match every request. */
export interface AddPredicateRuleInput {
  /** Source agent the rule applies to (e.g. "hermes"). `*` matches any. */
  sourceAgent: string;
  /** Rule target string, same shape as `evaluate()`'s `requestTarget`:
   *  `"<agentId>:<tool>"` for cross-agent, `"tool:<name>"` for plain
   *  tools, `"*"` for everything. */
  target: string;
  predicate: {
    pathMatch?: string[];
    toolPattern?: string;
    argContains?: string;
  };
  /** Approval row id that triggered the injection. Stamped onto the
   *  rule's conditions.source so audits + `foreman policy list` show
   *  the origin. */
  approvalId: string;
  /** Short human-language reason (typically the matched risk factor
   *  name, e.g. "secret_file_pattern_env"). Surfaces in the YAML
   *  comment block + the chat confirmation. */
  reason?: string;
  /** Optional policy.yaml path — when set, the rule is appended to
   *  the file with a provenance comment block so it survives the next
   *  `loadFromYaml` reload AND is editable by hand. When omitted, the
   *  rule lives in the DB only (still active; just not in the YAML). */
  policyYamlPath?: string;
}

/** #526 — Best-effort YAML append for an approval-injected rule. The
 *  file may be empty or have an existing `rules:` block; we handle both
 *  cases by appending a self-contained YAML list item with a comment
 *  block above it. We do NOT round-trip the existing YAML through the
 *  yaml lib (would lose comments + formatting); the append is plain
 *  text that the loader parses fine because it's valid YAML on its own.
 *
 *  When the file doesn't exist, the function creates it with a `rules:`
 *  block so the appended item is anchored correctly. */
function appendApprovalRuleToYaml(
  path: string,
  input: AddPredicateRuleInput,
  addedAt: number,
): void {
  const block = renderApprovalRuleYamlBlock(input, addedAt);
  if (!existsSync(path)) {
    writeFileSync(path, `rules:\n${block}`, "utf-8");
    return;
  }
  const existing = readFileSync(path, "utf-8");
  // If the file already has a `rules:` key, append to that block.
  // Otherwise, append a fresh `rules:` block at the end. Both paths
  // keep existing comments / formatting intact because we never
  // re-serialize what's already there.
  const hasRulesBlock = /^rules:\s*$/m.test(existing) || /^rules:\s*\n/m.test(existing);
  const sep = existing.endsWith("\n") ? "" : "\n";
  if (hasRulesBlock) {
    appendFileSync(path, `${sep}${block}`, "utf-8");
  } else {
    appendFileSync(path, `${sep}\nrules:\n${block}`, "utf-8");
  }
}

function renderApprovalRuleYamlBlock(
  input: AddPredicateRuleInput,
  addedAt: number,
): string {
  const iso = new Date(addedAt).toISOString();
  const lines: string[] = [];
  lines.push(`# === Foreman approval-injected rule ===`);
  lines.push(`# Added from approval ${input.approvalId} at ${iso}`);
  if (input.reason) {
    lines.push(`# Reason: ${input.reason}`);
  }
  lines.push(
    `# Edit / delete this rule by removing this entire block; Foreman won't re-add it.`,
  );
  lines.push(`  - source: ${input.sourceAgent}`);
  lines.push(`    target: ${input.target}`);
  lines.push(`    effect: deny`);
  lines.push(`    conditions:`);
  if (input.predicate.pathMatch && input.predicate.pathMatch.length > 0) {
    lines.push(`      pathMatch:`);
    for (const p of input.predicate.pathMatch) {
      // Pattern strings may contain regex metachars + backslashes; YAML
      // double-quote handles them with the standard escape rules.
      lines.push(`        - ${JSON.stringify(p)}`);
    }
  }
  if (input.predicate.toolPattern) {
    lines.push(`      toolPattern: ${JSON.stringify(input.predicate.toolPattern)}`);
  }
  if (input.predicate.argContains) {
    lines.push(`      argContains: ${JSON.stringify(input.predicate.argContains)}`);
  }
  return `${lines.join("\n")}\n`;
}

function safeRegexTest(pattern: string, input: string): boolean {
  try {
    return new RegExp(pattern).test(input);
  } catch {
    return false;
  }
}
