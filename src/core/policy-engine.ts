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
    rate_limits: z
      .object({
        messages_per_minute: z.number().int().positive().optional(),
        tokens_per_hour: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

const PolicyDocSchema = z
  .object({
    agents: z.record(z.string(), AgentEntrySchema).optional(),
    rules: z.array(RulesArrayItemSchema).optional(),
  })
  .strict();

const EFFECT_ORDER: Record<Effect, number> = { deny: 0, allow: 1, ask: 2 };

export class PolicyEngine {
  constructor(
    private readonly db: ForemanDb,
    private readonly bus: EventBus<ForemanEventMap> = defaultBus,
  ) {}

  loadFromYaml(path: string): { rulesAdded: number } {
    return this.loadYamlText(readFileSync(path, "utf-8"));
  }

  // Replaces every previously-yaml-loaded rule with the doc's contents.
  loadYamlText(text: string): { rulesAdded: number } {
    const parsed = parseYaml(text);
    const doc = parsed === null ? {} : PolicyDocSchema.parse(parsed);
    const now = Date.now();

    this.db.delete(policies).where(eq(policies.createdBy, "user")).run();

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

    if (rows.length === 0) return { rulesAdded: 0 };
    this.db.insert(policies).values(rows).run();
    return { rulesAdded: rows.length };
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
    return true;
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
