import { readFileSync } from "node:fs";
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
  rateLimits?: {
    messagesPerMinute?: number;
    tokensPerHour?: number;
  };
}

export interface RememberInput {
  sourceAgent: string;
  target: string;
  effect: Effect;
  conditions?: RuleConditions;
}

const RuleConditionsSchema: z.ZodType<RuleConditions> = z
  .object({
    pathMatch: z.array(z.string()).optional(),
    commandMatch: z.array(z.string()).optional(),
    pathNotMatch: z.string().optional(),
    rateLimits: z
      .object({
        messagesPerMinute: z.number().int().positive().optional(),
        tokensPerHour: z.number().int().positive().optional(),
      })
      .optional(),
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

const PolicyDocSchema = z
  .object({
    agents: z.record(z.string(), AgentEntrySchema).optional(),
    rules: z.array(RulesArrayItemSchema).optional(),
    buckets: BucketOverridesSchema.optional(),
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

  list(): (typeof policies.$inferSelect)[] {
    return this.db.select().from(policies).all();
  }

  getBucketOverrides(): BucketOverrides {
    return { ...this.bucketOverrides };
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
    return true;
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

function safeRegexTest(pattern: string, input: string): boolean {
  try {
    return new RegExp(pattern).test(input);
  } catch {
    return false;
  }
}
