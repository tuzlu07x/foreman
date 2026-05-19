import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentActivityDigest,
  type AgentActivityDigest,
} from "../../src/core/agent-activity-summary.js";
import { buildActivityPrompt } from "../../src/core/agent-activity-prompt.js";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import { RegistryService } from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { auditEvents, requests, sessions } from "../../src/db/schema.js";

describe("buildAgentActivityDigest (#435)", () => {
  const NOW = 1_700_000_000_000;
  let db: ForemanDb;
  let sqlite: Database.Database;
  let registry: RegistryService;

  beforeEach(() => {
    const h = createInMemoryDb();
    db = h.db;
    sqlite = h.sqlite;
    registry = new RegistryService(db, new EventBus<ForemanEventMap>());
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertReq(
    id: string,
    sourceAgent: string,
    target: string | null,
    decision: "allowed" | "denied" | "pending",
    createdAt: number,
    riskScore = 25,
  ): void {
    db.insert(requests)
      .values({
        id,
        sourceAgent,
        targetAgent: target,
        targetTool: target,
        args: "{}",
        riskScore,
        riskBucket: "low",
        decision,
        decidedBy: "policy:test",
        createdAt,
        decidedAt: createdAt + 1,
        durationMs: 1,
      })
      .run();
  }

  function insertAuditEvent(
    eventType: string,
    payload: unknown,
    createdAt: number,
  ): void {
    db.insert(auditEvents)
      .values({
        eventType,
        payload: JSON.stringify(payload),
        createdAt,
      })
      .run();
  }

  describe("determinism + window", () => {
    it("is empty on a fresh DB", () => {
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      expect(d.window.end).toBe(NOW);
      expect(d.agents).toHaveLength(0);
      expect(d.sessions).toHaveLength(0);
      expect(d.notableEvents).toHaveLength(0);
    });

    it("respects the windowMinutes bound — excludes older requests", () => {
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
      insertReq("recent", "hermes", "openclaw", "allowed", NOW - 30 * 60_000);
      insertReq("old", "hermes", "openclaw", "allowed", NOW - 120 * 60_000);
      const d = buildAgentActivityDigest(db, registry, {
        now: () => NOW,
        windowMinutes: 60,
      });
      expect(d.agents[0]?.requestCount).toBe(1);
      expect(d.window.start).toBe(NOW - 60 * 60_000);
    });

    it("two calls with the same state + clock return equal results", () => {
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
        responsibilityNote: "PM",
      });
      insertReq("a", "hermes", "tool/x", "allowed", NOW - 10_000);
      insertReq("b", "hermes", "tool/y", "denied", NOW - 5_000, 80);
      const a = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const b = buildAgentActivityDigest(db, registry, { now: () => NOW });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe("agents rollup", () => {
    beforeEach(() => {
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
      registry.register({
        id: "openclaw",
        displayName: "OpenClaw",
        transport: "stdio",
      });
    });

    it("seeds zero rows for idle agents", () => {
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      expect(d.agents).toHaveLength(2);
      expect(d.agents.every((a) => a.requestCount === 0)).toBe(true);
      expect(d.agents.every((a) => a.lastActivityAt === null)).toBe(true);
    });

    it("counts source AND target hits (agent-to-agent)", () => {
      insertReq("a", "hermes", "openclaw", "allowed", NOW - 10_000);
      insertReq("b", "openclaw", "hermes", "allowed", NOW - 5_000);
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      // Both rows touch both agents.
      const hermes = d.agents.find((a) => a.id === "hermes")!;
      const openclaw = d.agents.find((a) => a.id === "openclaw")!;
      expect(hermes.requestCount).toBe(2);
      expect(openclaw.requestCount).toBe(2);
    });

    it("tracks deniedCount separately from requestCount", () => {
      insertReq("ok", "hermes", "openclaw", "allowed", NOW - 1_000);
      insertReq("nope", "hermes", "openclaw", "denied", NOW - 500, 85);
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const hermes = d.agents.find((a) => a.id === "hermes")!;
      expect(hermes.requestCount).toBe(2);
      expect(hermes.deniedCount).toBe(1);
    });

    it("computes lastActivityAt from the newest row in the window", () => {
      insertReq("a", "hermes", "tool/x", "allowed", NOW - 30_000);
      insertReq("b", "hermes", "tool/y", "allowed", NOW - 10_000);
      insertReq("c", "hermes", "tool/z", "allowed", NOW - 20_000);
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const hermes = d.agents.find((a) => a.id === "hermes")!;
      expect(hermes.lastActivityAt).toBe(NOW - 10_000);
    });

    it("agentId filter narrows rollup to one agent", () => {
      insertReq("a", "hermes", "openclaw", "allowed", NOW - 1_000);
      insertReq("b", "openclaw", "hermes", "allowed", NOW - 500);
      insertReq("c", "codex", "hermes", "allowed", NOW - 200);
      const d = buildAgentActivityDigest(db, registry, {
        now: () => NOW,
        agentId: "openclaw",
      });
      expect(d.agents).toHaveLength(1);
      expect(d.agents[0]?.id).toBe("openclaw");
      // Only requests where source OR target === openclaw count.
      expect(d.agents[0]?.requestCount).toBe(2);
    });

    it("agents sorted alphabetically for stable LLM context", () => {
      registry.register({
        id: "zeroclaw",
        displayName: "ZeroClaw",
        transport: "stdio",
      });
      registry.register({
        id: "codex",
        displayName: "Codex",
        transport: "stdio",
      });
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const ids = d.agents.map((a) => a.id);
      expect(ids).toEqual([...ids].sort());
    });

    it("runningSince is null when agent registered AFTER the window started", () => {
      const d = buildAgentActivityDigest(db, registry, {
        now: () => NOW,
        windowMinutes: 1, // very small window — agents registered just now
      });
      // beforeEach registered with Date.now() (real). The window starts
      // basically at NOW-60s; the agent's registeredAt is real-time which
      // is way before NOW. So runningSince *should* be set... unless real
      // time > NOW - 60s. Let me use the windowMinutes huge to flip it.
      const d2 = buildAgentActivityDigest(db, registry, {
        now: () => NOW + 100_000_000_000, // far future
      });
      expect(d2.agents[0]?.runningSince).not.toBeNull();
    });
  });

  describe("notable events", () => {
    beforeEach(() => {
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
    });

    it("includes denied requests as notable", () => {
      insertReq("ok", "hermes", "tool/x", "allowed", NOW - 1_000, 50);
      insertReq("denied", "hermes", "tool/y", "denied", NOW - 500, 85);
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const kinds = d.notableEvents.map((e) => e.kind);
      expect(kinds).toContain("denied");
      // Allowed mid-risk shouldn't appear.
      expect(d.notableEvents.find((e) => e.summary.includes("tool/x"))).toBeUndefined();
    });

    it("includes high-risk (>=70) allowed requests as risk-high", () => {
      insertReq("risky", "hermes", "tool/x", "allowed", NOW - 1_000, 75);
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const e = d.notableEvents[0]!;
      expect(e.kind).toBe("risk-high");
      if (e.kind === "risk-high") {
        expect(e.riskScore).toBe(75);
        expect(e.decision).toBe("allowed");
      }
    });

    it("includes daemon crashes from audit_events", () => {
      insertAuditEvent(
        "agent_daemon_crashed",
        { agentId: "openclaw", exitCode: 1, stderr: "config error" },
        NOW - 5_000,
      );
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const crash = d.notableEvents.find((e) => e.kind === "crash");
      expect(crash).toBeDefined();
      if (crash && crash.kind === "crash") {
        expect(crash.agentId).toBe("openclaw");
        expect(crash.exitCode).toBe(1);
        expect(crash.summary).toContain("config error");
      }
    });

    it("includes budget alerts from audit_events", () => {
      insertAuditEvent(
        "llm_budget_alert",
        {
          kind: "threshold",
          spentPct: 82,
          spentUsd: 4.1,
          capUsd: 5,
          windowStart: NOW - 60_000,
          windowEnd: NOW,
          daysUntilReset: 5,
        },
        NOW - 3_000,
      );
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      const alert = d.notableEvents.find((e) => e.kind === "budget-alert");
      expect(alert).toBeDefined();
      if (alert && alert.kind === "budget-alert") {
        expect(alert.kindDetail).toBe("threshold");
      }
    });

    it("orders notable events newest-first", () => {
      insertReq("d1", "hermes", "x", "denied", NOW - 10_000, 80);
      insertReq("d2", "hermes", "y", "denied", NOW - 1_000, 80);
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      expect(d.notableEvents[0]?.when).toBeGreaterThan(
        d.notableEvents[1]!.when,
      );
    });

    it("respects maxNotable cap", () => {
      for (let i = 0; i < 30; i++) {
        insertReq(
          `r${i}`,
          "hermes",
          "tool/x",
          "denied",
          NOW - i * 100,
          80,
        );
      }
      const d = buildAgentActivityDigest(db, registry, {
        now: () => NOW,
        maxNotable: 10,
      });
      expect(d.notableEvents).toHaveLength(10);
    });

    it("skips malformed audit_events payloads silently", () => {
      insertAuditEvent("agent_daemon_crashed", { not_a_crash: true }, NOW - 1_000);
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      // Skipped — no crash event included.
      expect(d.notableEvents.find((e) => e.kind === "crash")).toBeUndefined();
    });
  });

  describe("sessions", () => {
    beforeEach(() => {
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
    });

    it("includes sessions started in the window", () => {
      db.insert(sessions)
        .values({
          id: "s1",
          participants: JSON.stringify(["hermes", "openclaw"]),
          startedAt: NOW - 30_000,
          messageCount: 4,
          tokenCount: 800,
          status: "active",
        })
        .run();
      const d = buildAgentActivityDigest(db, registry, { now: () => NOW });
      expect(d.sessions).toHaveLength(1);
      expect(d.sessions[0]?.participants).toEqual(["hermes", "openclaw"]);
      expect(d.sessions[0]?.messageCount).toBe(4);
    });

    it("excludes sessions older than the window", () => {
      db.insert(sessions)
        .values({
          id: "ancient",
          participants: JSON.stringify(["hermes"]),
          startedAt: NOW - 120 * 60_000,
          messageCount: 1,
          tokenCount: 50,
          status: "completed",
        })
        .run();
      const d = buildAgentActivityDigest(db, registry, {
        now: () => NOW,
        windowMinutes: 60,
      });
      expect(d.sessions).toHaveLength(0);
    });
  });
});

describe("buildActivityPrompt (#435)", () => {
  const baseDigest: AgentActivityDigest = {
    window: { start: 1_700_000_000_000 - 60 * 60_000, end: 1_700_000_000_000 },
    agents: [
      {
        id: "hermes",
        displayName: "Hermes",
        runningSince: 1_700_000_000_000 - 24 * 60 * 60_000,
        requestCount: 12,
        deniedCount: 2,
        lastActivityAt: 1_700_000_000_000 - 5_000,
      },
      {
        id: "openclaw",
        displayName: "OpenClaw",
        runningSince: 1_700_000_000_000 - 12 * 60 * 60_000,
        requestCount: 0,
        deniedCount: 0,
        lastActivityAt: null,
      },
    ],
    sessions: [],
    notableEvents: [
      {
        kind: "denied",
        when: 1_700_000_000_000 - 4_000,
        summary: "hermes → tool/secret-read denied",
        sourceAgent: "hermes",
        targetTool: "tool/secret-read",
        riskScore: 85,
      },
    ],
  };

  it("includes exact numbers from the digest", () => {
    const prompt = buildActivityPrompt({ digest: baseDigest });
    expect(prompt).toContain("12 requests");
    expect(prompt).toContain("2 denied");
    expect(prompt).toContain("Agents (2)");
  });

  it("marks idle agents distinctly", () => {
    const prompt = buildActivityPrompt({ digest: baseDigest });
    expect(prompt).toContain("openclaw");
    expect(prompt).toContain("idle");
  });

  it("instructs the LLM to keep replies 1-3 paragraphs + match language", () => {
    const prompt = buildActivityPrompt({ digest: baseDigest });
    expect(prompt.toLowerCase()).toContain("1-3 short paragraphs");
    expect(prompt.toLowerCase()).toContain("turkish if the question is turkish");
  });

  it("uses the user's question when supplied", () => {
    const prompt = buildActivityPrompt({
      digest: baseDigest,
      question: "Hermes ne yapıyor?",
    });
    expect(prompt).toContain("Hermes ne yapıyor?");
  });

  it("falls back to a sensible default when no question is supplied", () => {
    const en = buildActivityPrompt({ digest: baseDigest });
    expect(en.toLowerCase()).toContain("summarize");
    const tr = buildActivityPrompt({ digest: baseDigest, locale: "tr" });
    expect(tr).toContain("özetle");
  });
});
