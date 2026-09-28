import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ForemanDb } from "../db/client.js";
import { pendingApprovals, policies, requests } from "../db/schema.js";
import { claimedAgentOf, isUntrustedSource } from "./agent-identity.js";
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
  /** Why, when no policy row decided (e.g. `identity:untrusted-rate-limit`). */
  label?: string;
}

/** #618 — every unverified (`untrusted:*`) connection together, so cycling
 *  claimed ids can't multiply the budget: calls per minute, and approval
 *  prompts waiting on you at once. */
export const UNTRUSTED_CALLS_PER_MINUTE = 30;
export const UNTRUSTED_OPEN_APPROVALS = 3;

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

/** #618 — what an unverified (`untrusted:<id>`) MCP connection may do:
 *  `deny` quarantines it, `ask` (default) never auto-allows it, so every
 *  call it makes comes to you, and `allow_wildcards` lets `source: "*"`
 *  allow rules apply to it like to any unknown agent. The claimed agent's
 *  denials and limits bind it in every mode. */
const IdentitySchema = z
  .object({
    untrusted: z.enum(["deny", "ask", "allow_wildcards"]).optional(),
  })
  .strict();

export type UntrustedMode = "deny" | "ask" | "allow_wildcards";
export const DEFAULT_UNTRUSTED_MODE: UntrustedMode = "ask";

const PolicyDocSchema = z
  .object({
    identity: IdentitySchema.optional(),
    agents: z.record(z.string(), AgentEntrySchema).optional(),
    rules: z.array(RulesArrayItemSchema).optional(),
    buckets: BucketOverridesSchema.optional(),
    responsibility_policies: z.array(ResponsibilityPolicySchema).optional(),
    session_limits: SessionLimitsSchema.optional(),
  })
  .strict();

export type BucketOverrides = z.infer<typeof BucketOverridesSchema>;

/** Strictest first: ties between otherwise equal rules go to the safer effect. */
const EFFECT_ORDER: Record<Effect, number> = { deny: 0, ask: 1, allow: 2 };

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
  private untrustedMode: UntrustedMode = DEFAULT_UNTRUSTED_MODE;
  /** The policy.yaml this engine follows (#656), see watchFile(). */
  private watched: {
    path: string;
    stamp: string | null;
    checkedAt: number;
    reportedError: string | null;
    onError: (message: string) => void;
  } | null = null;

  constructor(
    private readonly db: ForemanDb,
    private readonly bus: EventBus<ForemanEventMap> = defaultBus,
  ) {}

  loadFromYaml(path: string): { rulesAdded: number } {
    const result = this.loadYamlText(readFileSync(path, "utf-8"));
    if (this.watched?.path === path) {
      this.watched.stamp = fileStamp(path);
      this.watched.reportedError = null;
    }
    return result;
  }

  /**
   * Follow `path` for the life of this process (#656): load it now, then
   * re-read it whenever it changes (one `stat` per evaluation, at most
   * every WATCH_INTERVAL_MS), so `foreman start` and every running
   * `foreman mcp-stdio` apply an edit on their next call. A file that
   * doesn't parse is not applied: the last good policy stays in force (the
   * rules already in the database) and `onError` hears about it once per
   * broken version. Never throws.
   */
  watchFile(path: string, onError: (message: string) => void = () => {}): void {
    this.watched = { path, stamp: null, checkedAt: 0, reportedError: null, onError };
    this.refreshWatched(true);
  }

  private refreshWatched(force = false): void {
    const w = this.watched;
    if (!w) return;
    const now = Date.now();
    if (!force && now - w.checkedAt < WATCH_INTERVAL_MS) return;
    w.checkedAt = now;
    const stamp = fileStamp(w.path);
    if (stamp === w.stamp) return;
    w.stamp = stamp;
    if (stamp === null) return; // deleted: keep what is loaded
    try {
      this.loadYamlText(readFileSync(w.path, "utf-8"));
      w.reportedError = null;
    } catch (err) {
      const message =
        `${w.path} could not be applied (${describePolicyError(err)}); ` +
        "the last good policy stays in force until the file is fixed";
      if (w.reportedError !== message) {
        w.reportedError = message;
        try {
          w.onError(message);
        } catch {
          // reporting is best-effort; enforcement must not depend on it
        }
      }
    }
  }

  // Replaces the yaml-loaded rules with the doc's contents. Rules that are
  // unchanged keep their row, and so their id (#656): audit rows such as
  // `allowed (policy:5)` keep pointing at the rule that decided them, in
  // every process and across restarts. Only removed rules are deleted and
  // only new ones inserted, inside one transaction so concurrent
  // evaluators never observe a partial policy.
  loadYamlText(text: string): { rulesAdded: number } {
    const parsed = parseYaml(text);
    const doc = parsed === null ? {} : PolicyDocSchema.parse(parsed);
    const now = Date.now();
    this.bucketOverrides = doc.buckets ?? {};
    this.responsibilityPolicies = doc.responsibility_policies ?? [];
    this.untrustedMode = doc.identity?.untrusted ?? DEFAULT_UNTRUSTED_MODE;
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
      const existing = new Map<string, number[]>();
      for (const row of tx.select().from(policies).where(eq(policies.createdBy, "user")).orderBy(policies.id).all()) {
        const key = ruleKey(row);
        existing.set(key, [...(existing.get(key) ?? []), row.id]);
      }
      const fresh: (typeof policies.$inferInsert)[] = [];
      for (const row of rows) {
        const ids = existing.get(ruleKey(row));
        if (ids && ids.length > 0) ids.shift();
        else fresh.push(row);
      }
      const stale = [...existing.values()].flat();
      if (stale.length > 0) tx.delete(policies).where(inArray(policies.id, stale)).run();
      if (fresh.length > 0) tx.insert(policies).values(fresh).run();
    });
    return { rulesAdded: rows.length };
  }

  // Secret access is deny-by-default. Only an explicit allow rule grants access;
  // anything else (no rule, conflicting rule, missing entry) denies.
  evaluateSecretAccess(
    sourceAgent: string,
    secretName: string,
  ): Evaluation & { decidedBy: string } {
    this.refreshWatched();
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
    // #618 — only `identity.untrusted: allow_wildcards` lets an unverified
    // connection read secrets through a `*` rule at all.
    if (isUntrustedSource(sourceAgent) && this.untrustedMode !== "allow_wildcards") {
      return { decision: "deny", decidedBy: "policy:identity:untrusted" };
    }
    // #618 — the claimed agent's secret denials bind an unverified connection.
    if (winner && winner.effect === "allow" && isUntrustedSource(sourceAgent)) {
      const claimedDeny = this.db
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.sourceAgent, claimedAgentOf(sourceAgent)),
            eq(policies.target, target),
            eq(policies.effect, "deny"),
            eq(policies.enabled, 1),
          ),
        )
        .get();
      if (claimedDeny) {
        return { decision: "deny", matchedRuleId: claimedDeny.id, decidedBy: `policy:cannot_access_secrets` };
      }
    }
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
    this.refreshWatched();
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

    const matching = candidates.filter((rule) => this.conditionsPass(rule, req));
    // An explicit deny aimed at this agent always wins.
    const exactDeny = matching.find(
      (r) => r.sourceAgent === req.sourceAgent && r.effect === "deny",
    );
    if (exactDeny) return { decision: "deny", matchedRuleId: exactDeny.id };
    // A rule overrides another only when it is more specific on one axis
    // (exact source, conditions) and no less specific on the other. Among
    // the rules nothing overrides, the strictest decides. So "always allow
    // read_file" for one agent beats a blanket wildcard ask, but not a
    // targeted wildcard guard (".env reads ask"); and a wildcard conditional
    // allow can't lift an ask aimed at this agent.
    const rank = (r: (typeof matching)[number]): [number, number] => [
      r.sourceAgent === req.sourceAgent ? 1 : 0,
      r.conditions ? 1 : 0,
    ];
    const overrides = (a: (typeof matching)[number], b: (typeof matching)[number]): boolean => {
      const [aSource, aCond] = rank(a);
      const [bSource, bCond] = rank(b);
      return aSource >= bSource && aCond >= bCond && (aSource > bSource || aCond > bCond);
    };
    const undominated = matching.filter((r) => !matching.some((o) => overrides(o, r)));
    undominated.sort((a, b) => EFFECT_ORDER[a.effect] - EFFECT_ORDER[b.effect] || a.id - b.id);
    const winner = undominated[0];
    const result: Evaluation = winner ? { decision: winner.effect, matchedRuleId: winner.id } : { decision: "ask" };
    return this.withUntrustedMode(req, this.withClaimedRestrictions(req, target, result));
  }

  getUntrustedMode(): UntrustedMode {
    this.refreshWatched();
    return this.untrustedMode;
  }

  /** `identity.untrusted` from policy.yaml (#618). */
  private withUntrustedMode(req: EvaluateRequest, result: Evaluation): Evaluation {
    if (!isUntrustedSource(req.sourceAgent) || result.decision === "deny") return result;
    if (this.untrustedMode === "deny") return { decision: "deny", label: "identity:untrusted" };
    if (this.untrustedMode === "ask" && result.decision === "allow") return { decision: "ask", label: "identity:untrusted" };
    return result;
  }

  /** An unverified `untrusted:<id>` connection (#618) gets none of <id>'s
   *  allow rules, but <id>'s deny and ask rules still bind it: dropping the
   *  token must never loosen a restriction. */
  private withClaimedRestrictions(req: EvaluateRequest, target: string, result: Evaluation): Evaluation {
    if (!isUntrustedSource(req.sourceAgent) || result.decision === "deny") return result;
    const claimed = claimedAgentOf(req.sourceAgent);
    const restrictions = this.db
      .select()
      .from(policies)
      .where(and(eq(policies.sourceAgent, claimed), eq(policies.target, target), eq(policies.enabled, 1)))
      .all()
      .filter((r) => r.effect !== "allow" && this.conditionsPass(r, { ...req, sourceAgent: claimed }))
      .sort((a, b) => EFFECT_ORDER[a.effect] - EFFECT_ORDER[b.effect] || a.id - b.id);
    const strictest = restrictions[0];
    if (!strictest || EFFECT_ORDER[strictest.effect] >= EFFECT_ORDER[result.decision]) return result;
    return { decision: strictest.effect, matchedRuleId: strictest.id };
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
    this.refreshWatched();
    return { ...this.bucketOverrides };
  }

  // Snapshot of the responsibility-policy block from the most recent YAML
  // load (#299). The #300 risk rule reads this every call so a YAML reload
  // takes effect without a process restart. Returns a shallow copy so the
  // caller can't mutate engine state.
  getResponsibilityPolicies(): ResponsibilityPolicy[] {
    this.refreshWatched();
    return this.responsibilityPolicies.map((p) => ({ ...p }));
  }

  /** #529 — Snapshot of the session_limits block from the most recent YAML
   *  load. `SessionManager` reads `tokenLimit` per `recordTurn` and the
   *  loop-detection rule reads `tokenBudgetWarningPct` per assess() so a
   *  YAML reload takes effect mid-session. Returns a shallow copy so
   *  callers can't mutate engine state by accident. */
  getSessionLimits(): SessionLimits {
    this.refreshWatched();
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

  // Conditions narrow a rule to specific calls. Anything the engine cannot
  // evaluate (corrupt JSON, an invalid regex such as the glob "*.env")
  // fails SAFE: a restrictive rule (deny / ask) still applies, a permissive
  // one (allow) does not. Previously an invalid pattern silently disabled a
  // deny rule and let the blanket allow win.
  private conditionsPass(
    rule: typeof policies.$inferSelect,
    req: EvaluateRequest,
  ): boolean {
    if (!rule.conditions) return true;
    const restrictive = rule.effect !== "allow";
    const cond = this.parseConditions(rule.conditions);
    if (!cond) return restrictive;
    const paths = extractPaths(req.args);
    // Restrictive rules apply when ANY path/command in the call matches;
    // an allow rule only when EVERY one does, so a second argument (or the
    // `..`-collapsed form of the first) can't ride along on an allowed one.
    if (cond.pathNotMatch) {
      const excluded = paths.map((p) => testPattern(cond.pathNotMatch!, p));
      if (excluded.includes("invalid")) {
        if (!restrictive) return false;
      } else if (restrictive) {
        if (paths.length > 0 && excluded.every((hit) => hit === true)) return false;
      } else if (excluded.some((hit) => hit === true)) {
        return false;
      }
    }
    if (cond.pathMatch && cond.pathMatch.length > 0) {
      if (paths.length === 0) return false;
      const hits = paths.map((p) => {
        let hit = false;
        for (const pattern of cond.pathMatch!) {
          const r = testPattern(pattern, p);
          if (r === "invalid") {
            if (!restrictive) return false;
            hit = true;
          } else if (r) {
            hit = true;
          }
        }
        return hit;
      });
      if (restrictive ? !hits.some(Boolean) : !hits.every(Boolean)) return false;
    }
    if (cond.commandMatch && cond.commandMatch.length > 0) {
      const commands = extractCommands(req.args);
      if (commands.length === 0) return false;
      const hits = commands.map((command) => {
        const normalised = command.replace(/\s+/g, " ");
        return cond.commandMatch!.some((sub) => normalised.includes(sub.replace(/\s+/g, " ")));
      });
      if (restrictive ? !hits.some(Boolean) : !hits.every(Boolean)) return false;
    }
    // #526 — toolPattern: rule applies when the request's targetTool matches
    // the regex. AND'd with the other predicates so a "block all read_* on
    // hermes" rule narrows by tool while leaving path matching open.
    if (cond.toolPattern) {
      if (!req.targetTool) return false;
      const r = testPattern(cond.toolPattern, req.targetTool, "");
      if (r === "invalid" ? !restrictive : !r) return false;
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

  private checkRateLimits(req: EvaluateRequest): Evaluation | null {
    // An unverified connection is held to the claimed agent's limits too,
    // counting both ids: dropping the token must not reset the budget.
    const untrusted = isUntrustedSource(req.sourceAgent);
    const counted = untrusted ? [req.sourceAgent, claimedAgentOf(req.sourceAgent)] : [req.sourceAgent];
    const rules = this.db
      .select()
      .from(policies)
      .where(
        and(
          inArray(policies.sourceAgent, [...counted, "*"]),
          eq(policies.enabled, 1),
        ),
      )
      .all();

    const since = Date.now() - 60_000;
    for (const rule of rules) {
      if (!rule.conditions) continue;
      const cond = this.parseConditions(rule.conditions);
      const limit = cond?.rateLimits?.messagesPerMinute;
      if (!limit) continue;

      const row = this.db
        .select({ count: sql<number>`count(*)` })
        .from(requests)
        .where(
          and(
            inArray(requests.sourceAgent, counted),
            gte(requests.createdAt, since),
          ),
        )
        .get();
      if ((row?.count ?? 0) >= limit) {
        return { decision: "deny", matchedRuleId: rule.id };
      }
    }
    return untrusted ? this.checkUntrustedFlood(since) : null;
  }

  private checkUntrustedFlood(since: number): Evaluation | null {
    const recent = this.db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(and(like(requests.sourceAgent, "untrusted:%"), gte(requests.createdAt, since)))
      .get();
    const waiting = this.db
      .select({ count: sql<number>`count(*)` })
      .from(pendingApprovals)
      .where(and(like(pendingApprovals.sourceAgent, "untrusted:%"), eq(pendingApprovals.status, "pending")))
      .get();
    if ((recent?.count ?? 0) >= UNTRUSTED_CALLS_PER_MINUTE || (waiting?.count ?? 0) >= UNTRUSTED_OPEN_APPROVALS) {
      return { decision: "deny", label: "identity:untrusted-rate-limit" };
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

/** How often a watched policy.yaml is stat'ed at most (#656). */
const WATCH_INTERVAL_MS = 250;

/** Changes whenever the file's content can have changed. */
function fileStamp(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return null;
  }
}

/** Identity of a yaml rule: same source, target, effect and conditions. */
function ruleKey(row: { sourceAgent: string; target: string; effect: string; conditions?: string | null }): string {
  return JSON.stringify([row.sourceAgent, row.target, row.effect, row.conditions ?? null]);
}

function describePolicyError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.slice(0, 200);
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

/** Path patterns match case-insensitively by default (macOS and Windows
 *  filesystems are, so `.ENV` is `.env`). `"invalid"` lets callers fail safe. */
function testPattern(pattern: string, input: string, flags = "i"): boolean | "invalid" {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return "invalid";
  }
  return re.test(input);
}

/** Every command-like field of a call. Adapters emit `cmd` (shell_exec),
 *  MCP shell tools use `command` (+ `args`), some use `script`; a call that
 *  carries several is judged on all of them, so a decoy `cmd` can't hide
 *  the `command` that actually runs. */
function extractCommands(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const obj = args as { command?: unknown; args?: unknown; cmd?: unknown; script?: unknown };
  const out: string[] = [];
  if (typeof obj.cmd === "string") out.push(obj.cmd);
  if (typeof obj.script === "string") out.push(obj.script);
  if (typeof obj.command === "string") {
    out.push(
      Array.isArray(obj.args) ? [obj.command, ...obj.args.map(String)].join(" ") : obj.command,
    );
  } else if (Array.isArray(obj.command)) {
    out.push(obj.command.map(String).join(" "));
  }
  return out;
}

/** Every regex in a conditions block that fails to compile — surfaced by
 *  `foreman doctor` so a typo'd pattern doesn't go unnoticed. */
export function invalidPatterns(conditions: RuleConditions): string[] {
  const candidates = [
    ...(conditions.pathMatch ?? []),
    ...(conditions.pathNotMatch ? [conditions.pathNotMatch] : []),
    ...(conditions.toolPattern ? [conditions.toolPattern] : []),
  ];
  return candidates.filter((p) => {
    try {
      new RegExp(p);
      return false;
    } catch {
      return true;
    }
  });
}

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filename",
  "file",
  "notebook_path",
  "target_path",
  "source",
  "destination",
  "paths",
];

/** Every path-like argument of a call, each also in a normalised form
 *  (backslashes → '/', `a/../b` collapsed) so `x/../.env` and `{file_path}`
 *  can't slip past a pattern written for `args.path`. */
export function extractPaths(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) {
      out.add(value);
      out.add(normalisePath(value));
    } else if (Array.isArray(value)) {
      for (const v of value.slice(0, 256)) add(v);
    }
  };
  for (const key of PATH_KEYS) add((args as Record<string, unknown>)[key]);
  return [...out];
}

function normalisePath(p: string): string {
  const slashed = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const absolute = slashed.startsWith("/");
  const parts: string[] = [];
  for (const seg of slashed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(seg);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}
