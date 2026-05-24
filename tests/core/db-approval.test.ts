import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalBridge,
  DbApprovalService,
  type ApprovalRequest,
} from "../../src/core/approval.js";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { pendingApprovals } from "../../src/db/schema.js";

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "req_test_1",
    sourceAgent: "claude-code",
    targetTool: "read_file",
    args: { path: ".env" },
    riskScore: 80,
    riskReasons: ["secret_file_pattern"],
    riskFactors: [],
    riskBucket: "high",
    llmVerification: null,
    securityReport: null,
    ...overrides,
  };
}

describe("DbApprovalService", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("inserts a pending row and polls until the bridge resolves it", async () => {
    const service = new DbApprovalService(db, {
      bus,
      timeoutMs: 5000,
      pollIntervalMs: 25,
    });

    const promise = service.request(req());

    // Simulate the TUI bridge writing the decision back.
    await new Promise((r) => setTimeout(r, 60));
    db.update(pendingApprovals)
      .set({
        status: "resolved",
        decision: "allowed",
        resolvedBy: "user",
        resolvedAt: Date.now(),
      })
      .run();

    const decision = await promise;
    expect(decision.decision).toBe("allowed");
  });

  it("times out and resolves denied when no decision arrives", async () => {
    const service = new DbApprovalService(db, {
      bus,
      timeoutMs: 100,
      pollIntervalMs: 25,
    });
    const decision = await service.request(req({ requestId: "to-deny" }));
    expect(decision.decision).toBe("denied");
    const row = db
      .select()
      .from(pendingApprovals)
      .all()
      .find((r) => r.requestId === "to-deny");
    expect(row?.status).toBe("resolved");
    expect(row?.resolvedBy).toBe("timeout");
  });

  it("emits approval:resolved on the local bus once decided", async () => {
    const service = new DbApprovalService(db, {
      bus,
      timeoutMs: 1000,
      pollIntervalMs: 25,
    });
    const resolved: ForemanEventMap["approval:resolved"][] = [];
    bus.on("approval:resolved", (e) => resolved.push(e));

    const promise = service.request(req({ requestId: "to-emit" }));
    await new Promise((r) => setTimeout(r, 50));
    db.update(pendingApprovals)
      .set({
        status: "resolved",
        decision: "denied",
        resolvedBy: "user",
        resolvedAt: Date.now(),
      })
      .run();
    await promise;
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.decision).toBe("denied");
    expect(resolved[0]?.resolvedBy).toBe("user");
  });
});

describe("ApprovalBridge", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("forwards pending DB rows to the local bus as approval:requested", async () => {
    const requests: ForemanEventMap["approval:requested"][] = [];
    bus.on("approval:requested", (e) => requests.push(e));

    const bridge = new ApprovalBridge(db, { bus, pollIntervalMs: 25 });
    bridge.start();

    // Service inserts a pending row (cross-process simulation).
    db.insert(pendingApprovals)
      .values({
        requestId: "bridge-1",
        sourceAgent: "claude-code",
        targetTool: "read_file",
        args: JSON.stringify({ path: ".env" }),
        riskScore: 80,
        riskReasons: JSON.stringify(["secret_file"]),
        status: "pending",
        requestedAt: Date.now(),
      })
      .run();

    await new Promise((r) => setTimeout(r, 80));
    bridge.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestId).toBe("bridge-1");
    expect(requests[0]?.targetTool).toBe("read_file");
    expect(requests[0]?.riskReasons).toEqual(["secret_file"]);
  });

  it("writes approval:resolved decisions back to the pending row", async () => {
    db.insert(pendingApprovals)
      .values({
        requestId: "bridge-2",
        sourceAgent: "claude-code",
        args: "{}",
        riskScore: 0,
        riskReasons: "[]",
        status: "pending",
        requestedAt: Date.now(),
      })
      .run();

    const bridge = new ApprovalBridge(db, { bus, pollIntervalMs: 25 });
    bridge.start();
    await new Promise((r) => setTimeout(r, 40));

    bus.emit("approval:resolved", {
      requestId: "bridge-2",
      decision: "allowed",
      remember: "allow",
      resolvedBy: "user",
    });
    await new Promise((r) => setTimeout(r, 40));
    bridge.stop();

    const row = db
      .select()
      .from(pendingApprovals)
      .all()
      .find((r) => r.requestId === "bridge-2");
    expect(row?.status).toBe("resolved");
    expect(row?.decision).toBe("allowed");
    expect(row?.remember).toBe("allow");
    expect(row?.resolvedBy).toBe("user");
  });

  it("does not re-emit the same pending row twice", async () => {
    db.insert(pendingApprovals)
      .values({
        requestId: "bridge-3",
        sourceAgent: "claude-code",
        args: "{}",
        riskScore: 0,
        riskReasons: "[]",
        status: "pending",
        requestedAt: Date.now(),
      })
      .run();

    const requests: ForemanEventMap["approval:requested"][] = [];
    bus.on("approval:requested", (e) => requests.push(e));

    const bridge = new ApprovalBridge(db, { bus, pollIntervalMs: 25 });
    bridge.start();
    await new Promise((r) => setTimeout(r, 120));
    bridge.stop();

    expect(requests).toHaveLength(1);
  });

  // #406 — Agent-routed approval submission. Hermes / OpenClaw call the
  // `submit_approval` MCP tool when the user types `/approve <id>` in
  // their chat; mcp-stdio forwards to this method.
  describe("submitFromAgent (#406)", () => {
    it("validates the approval row exists + is pending, then emits the bus event", async () => {
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 25,
      });
      db.insert(pendingApprovals)
        .values({
          requestId: "agent-route-1",
          sourceAgent: "claude-code",
          args: "{}",
          riskScore: 50,
          riskReasons: "[]",
          status: "pending",
          requestedAt: Date.now(),
        })
        .run();
      const events: ForemanEventMap["approval:resolved"][] = [];
      bus.on("approval:resolved", (e) => events.push(e));
      const out = await service.submitFromAgent({
        approvalId: "agent-route-1",
        decision: "allow",
        sourceAgent: "hermes",
      });
      expect(out.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        requestId: "agent-route-1",
        decision: "allowed",
        resolvedBy: "agent",
        via: "agent_mcp",
        routedBy: "hermes",
      });
    });

    it("emits remember when the caller asked for it", async () => {
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 25,
      });
      db.insert(pendingApprovals)
        .values({
          requestId: "agent-route-remember",
          sourceAgent: "claude-code",
          args: "{}",
          riskScore: 50,
          riskReasons: "[]",
          status: "pending",
          requestedAt: Date.now(),
        })
        .run();
      const events: ForemanEventMap["approval:resolved"][] = [];
      bus.on("approval:resolved", (e) => events.push(e));
      await service.submitFromAgent({
        approvalId: "agent-route-remember",
        decision: "deny",
        remember: true,
        sourceAgent: "openclaw",
      });
      expect(events[0]).toMatchObject({
        decision: "denied",
        remember: "deny",
        routedBy: "openclaw",
      });
    });

    it("returns ok=false with a clear error when the approval id doesn't exist", async () => {
      const service = new DbApprovalService(db, { bus });
      const out = await service.submitFromAgent({
        approvalId: "never-existed",
        decision: "allow",
        sourceAgent: "hermes",
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/not found/);
    });

    it("returns ok=false when the approval is already resolved", async () => {
      const service = new DbApprovalService(db, { bus });
      db.insert(pendingApprovals)
        .values({
          requestId: "already-done",
          sourceAgent: "claude-code",
          args: "{}",
          riskScore: 50,
          riskReasons: "[]",
          status: "resolved",
          decision: "denied",
          resolvedBy: "timeout",
          requestedAt: Date.now() - 60_000,
          resolvedAt: Date.now() - 1000,
        })
        .run();
      const out = await service.submitFromAgent({
        approvalId: "already-done",
        decision: "allow",
        sourceAgent: "hermes",
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/already/);
    });

    it("end-to-end: agent submission unblocks an in-flight request() call", async () => {
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 20,
      });
      // The bridge writes status=resolved when it sees the bus event.
      const bridge = new ApprovalBridge(db, { bus, pollIntervalMs: 20 });
      bridge.start();
      try {
        const pending = service.request(req({ requestId: "e2e-agent-1" }));
        // Give request() a tick to insert the row.
        await new Promise((r) => setTimeout(r, 30));
        const out = await service.submitFromAgent({
          approvalId: "e2e-agent-1",
          decision: "allow",
          sourceAgent: "hermes",
        });
        expect(out.ok).toBe(true);
        const decision = await pending;
        expect(decision.decision).toBe("allowed");
      } finally {
        bridge.stop();
      }
    });

    // ============================================================================
    // #526 — Custom action path: agent passes action_id (block_*) → Foreman
    // injects a predicate-based deny rule + coerces the decision to deny.
    // ============================================================================

    // #526 custom-action path tests don't need a real request() poll
    // loop — they exercise submitFromAgent in isolation. Use a helper
    // that inserts the pending row directly so the test doesn't leave
    // a dangling polling promise after afterEach() closes the DB.
    function seedPending(
      approvalId: string,
      overrides: Partial<typeof pendingApprovals.$inferInsert> = {},
    ): void {
      db.insert(pendingApprovals)
        .values({
          requestId: approvalId,
          sourceAgent: "hermes",
          targetAgent: null,
          targetTool: "read_file",
          args: JSON.stringify({ path: ".env" }),
          riskScore: 80,
          riskReasons: JSON.stringify(["secret_path"]),
          riskFactors: JSON.stringify([
            {
              rule: "secret_path",
              category: "secret",
              points: 60,
              reason: ".env-style file",
            },
          ]),
          riskBucket: "high",
          status: "pending",
          requestedAt: Date.now(),
          ...overrides,
        })
        .run();
    }

    it('custom action_id triggers the policy injector + coerces decision to deny (#526)', async () => {
      const injected: unknown[] = [];
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 20,
        injectPredicateRule: (input) => {
          injected.push(input);
          return 42;
        },
      });
      seedPending("block-1");
      const out = await service.submitFromAgent({
        approvalId: "block-1",
        decision: "allow", // agent passed allow; coerced to deny by the custom path
        sourceAgent: "hermes",
        actionId: "block_secret_path",
      });
      expect(out.ok).toBe(true);
      expect(out.policyRuleId).toBe(42);
      expect(injected).toHaveLength(1);
      expect(injected[0]).toMatchObject({
        approvalId: "block-1",
        sourceAgent: "hermes",
        target: "tool:read_file",
        predicate: { pathMatch: ["\\.env(\\..*)?$"] },
        reason: "secret_path",
      });
    });

    it('emits approval:resolved with decision=denied for block_* actions (#526)', async () => {
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 20,
        injectPredicateRule: () => 7,
      });
      seedPending("block-emit-1");
      const events: ForemanEventMap["approval:resolved"][] = [];
      bus.on("approval:resolved", (e) => events.push(e));
      await service.submitFromAgent({
        approvalId: "block-emit-1",
        decision: "allow", // intentionally allow — must still flip to denied
        sourceAgent: "hermes",
        actionId: "block_secret_path",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        requestId: "block-emit-1",
        decision: "denied",
        via: "agent_mcp",
        routedBy: "hermes",
      });
    });

    it('rejects custom action_id when no matching risk factor exists on the row (#526)', async () => {
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 20,
        injectPredicateRule: () => 1,
      });
      // Pending row has secret_path factor but the agent claims a
      // shell action — should reject cleanly.
      seedPending("noface-1");
      const out = await service.submitFromAgent({
        approvalId: "noface-1",
        decision: "deny",
        sourceAgent: "hermes",
        actionId: "block_shell_rm_rf_general",
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/unknown action_id/);
    });

    it('returns an error when policy injection is not wired (#526)', async () => {
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 20,
        // No injectPredicateRule — simulates a Foreman build that didn't
        // wire the policy engine into the approval service.
      });
      seedPending("noinjector-1");
      const out = await service.submitFromAgent({
        approvalId: "noinjector-1",
        decision: "deny",
        sourceAgent: "hermes",
        actionId: "block_secret_path",
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/policy injection not wired/);
    });

    it('plain allow/deny path is unchanged when action_id is absent (#526 backward-compat)', async () => {
      const injected: unknown[] = [];
      const service = new DbApprovalService(db, {
        bus,
        timeoutMs: 5000,
        pollIntervalMs: 20,
        injectPredicateRule: (input) => {
          injected.push(input);
          return 99;
        },
      });
      seedPending("plain-1");
      const events: ForemanEventMap["approval:resolved"][] = [];
      bus.on("approval:resolved", (e) => events.push(e));
      const out = await service.submitFromAgent({
        approvalId: "plain-1",
        decision: "allow",
        sourceAgent: "hermes",
        // no actionId
      });
      expect(out.ok).toBe(true);
      expect(out.policyRuleId).toBeUndefined();
      expect(injected).toHaveLength(0); // injector not called for plain path
      expect(events[0]?.decision).toBe("allowed"); // not coerced to denied
    });
  });
});
