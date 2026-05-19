import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import {
  buildOrchestratorPrompt,
  buildOrchestratorSnapshot,
} from "../../src/core/orchestrator-snapshot.js";
import { RegistryService } from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { requests, sessions } from "../../src/db/schema.js";

describe("buildOrchestratorSnapshot (#432)", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let registry: RegistryService;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    registry = new RegistryService(db, new EventBus<ForemanEventMap>());
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertRequest(
    id: string,
    sourceAgent: string,
    targetAgent: string | null,
    decision: "allowed" | "denied" | "pending",
    createdAt: number,
    extra: Partial<typeof requests.$inferInsert> = {},
  ): void {
    db.insert(requests)
      .values({
        id,
        sourceAgent,
        targetAgent,
        targetTool: extra.targetTool ?? "tool/x",
        args: extra.args ?? "{}",
        riskScore: extra.riskScore ?? 25,
        riskBucket: extra.riskBucket ?? "low",
        decision,
        decidedBy: extra.decidedBy ?? "policy:test",
        createdAt,
        decidedAt: extra.decidedAt ?? createdAt + 5,
        durationMs: extra.durationMs ?? 5,
      })
      .run();
  }

  it("returns empty snapshot on a fresh DB", () => {
    const snap = buildOrchestratorSnapshot(db, registry, { now: () => NOW });
    expect(snap.recentRequests).toHaveLength(0);
    expect(snap.activeSessions).toHaveLength(0);
    expect(snap.agents).toHaveLength(0);
    expect(snap.capturedAt).toBe(NOW);
  });

  it("caps requests at lastN (default 30)", () => {
    for (let i = 0; i < 50; i++) {
      insertRequest(`r${i}`, "hermes", "openclaw", "allowed", NOW - i * 1000);
    }
    const snap = buildOrchestratorSnapshot(db, registry, { now: () => NOW });
    expect(snap.recentRequests).toHaveLength(30);
    // Newest first — r0 should be at index 0.
    expect(snap.recentRequests[0]?.requestId).toBe("r0");
  });

  it("respects custom lastN override", () => {
    for (let i = 0; i < 10; i++) {
      insertRequest(`r${i}`, "hermes", "openclaw", "allowed", NOW - i * 1000);
    }
    const snap = buildOrchestratorSnapshot(db, registry, {
      lastN: 5,
      now: () => NOW,
    });
    expect(snap.recentRequests).toHaveLength(5);
  });

  it("filters by agentId on source OR target", () => {
    insertRequest("r1", "hermes", "openclaw", "allowed", NOW - 1000);
    insertRequest("r2", "openclaw", "hermes", "allowed", NOW - 2000);
    insertRequest("r3", "codex", "hermes", "denied", NOW - 3000);
    insertRequest("r4", "zeroclaw", "claude-code", "allowed", NOW - 4000);

    const snap = buildOrchestratorSnapshot(db, registry, {
      agentId: "openclaw",
      now: () => NOW,
    });
    const ids = snap.recentRequests.map((r) => r.requestId);
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
    expect(ids).not.toContain("r3");
    expect(ids).not.toContain("r4");
  });

  it("includes registered agents from the registry", () => {
    registry.register({
      id: "hermes",
      displayName: "Hermes",
      transport: "stdio",
      responsibilityNote: "Project manager",
    });
    registry.register({
      id: "openclaw",
      displayName: "OpenClaw",
      transport: "stdio",
    });
    const snap = buildOrchestratorSnapshot(db, registry, { now: () => NOW });
    expect(snap.agents).toHaveLength(2);
    const hermes = snap.agents.find((a) => a.id === "hermes");
    expect(hermes?.responsibilityNote).toBe("Project manager");
    expect(snap.agents.find((a) => a.id === "openclaw")?.responsibilityNote).toBeNull();
  });

  it("captures sessions started inside the window", () => {
    insertRequest("r1", "hermes", "openclaw", "allowed", NOW - 60_000);
    db.insert(sessions)
      .values({
        id: "s1",
        participants: JSON.stringify(["hermes", "openclaw"]),
        startedAt: NOW - 30_000,
        messageCount: 7,
        tokenCount: 1200,
        status: "active",
      })
      .run();
    const snap = buildOrchestratorSnapshot(db, registry, { now: () => NOW });
    expect(snap.activeSessions).toHaveLength(1);
    expect(snap.activeSessions[0]?.participants).toEqual([
      "hermes",
      "openclaw",
    ]);
    expect(snap.activeSessions[0]?.messageCount).toBe(7);
  });

  it("falls back to a 24h session window when there are no requests", () => {
    db.insert(sessions)
      .values({
        id: "s1",
        participants: JSON.stringify(["hermes"]),
        startedAt: NOW - 10 * 60 * 60 * 1000,
        messageCount: 3,
        tokenCount: 500,
        status: "active",
      })
      .run();
    const snap = buildOrchestratorSnapshot(db, registry, { now: () => NOW });
    expect(snap.activeSessions).toHaveLength(1);
  });
});

describe("buildOrchestratorPrompt (#432)", () => {
  const baseSnap = {
    windowMs: { start: 1_700_000_000_000 - 60_000, end: 1_700_000_000_000 },
    recentRequests: [
      {
        requestId: "r1",
        sourceAgent: "hermes",
        targetAgent: "openclaw",
        targetTool: "tool/x",
        decision: "allowed" as const,
        decidedBy: "policy:7",
        riskScore: 20,
        riskBucket: "low" as const,
        createdAt: 1_700_000_000_000 - 30_000,
        durationMs: 5,
      },
    ],
    activeSessions: [
      {
        id: "s1",
        participants: ["hermes", "openclaw"],
        status: "active" as const,
        messageCount: 4,
        tokenCount: 800,
        startedAt: 1_700_000_000_000 - 45_000,
      },
    ],
    agents: [
      {
        id: "hermes",
        displayName: "Hermes",
        status: "active" as const,
        lastSeenAt: 1_700_000_000_000 - 5_000,
        responsibilityNote: "PM",
      },
      {
        id: "openclaw",
        displayName: "OpenClaw",
        status: "active" as const,
        lastSeenAt: 1_700_000_000_000 - 10_000,
        responsibilityNote: null,
      },
    ],
    capturedAt: 1_700_000_000_000,
  };

  it("embeds the user's question verbatim", () => {
    const prompt = buildOrchestratorPrompt({
      snapshot: baseSnap,
      question: "What is OpenClaw up to right now?",
    });
    expect(prompt).toContain("What is OpenClaw up to right now?");
  });

  it("flags a focus agent when supplied", () => {
    const prompt = buildOrchestratorPrompt({
      snapshot: baseSnap,
      question: "OpenClaw ne yapıyor?",
      focusAgentId: "openclaw",
    });
    expect(prompt).toContain("agent **openclaw** specifically");
  });

  it("lists every registered agent with its responsibility note", () => {
    const prompt = buildOrchestratorPrompt({
      snapshot: baseSnap,
      question: "report",
    });
    expect(prompt).toContain("hermes (Hermes, active");
    expect(prompt).toContain("role: PM");
    expect(prompt).toContain("openclaw (OpenClaw, active");
  });

  it("renders requests with relative-time labels", () => {
    const prompt = buildOrchestratorPrompt({
      snapshot: baseSnap,
      question: "x",
    });
    expect(prompt).toContain("hermes → tool/x");
    expect(prompt).toMatch(/\d+s ago|\d+m ago/);
  });

  it("instructs the LLM to match the user's language", () => {
    const prompt = buildOrchestratorPrompt({
      snapshot: baseSnap,
      question: "ne durumda?",
    });
    expect(prompt.toLowerCase()).toContain("turkish");
  });
});
