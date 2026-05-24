import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { createHeuristicClassifier } from "../../src/core/flow-classifier.js";
import { FlowManager } from "../../src/core/flow-manager.js";
import { FlowRouter, parseHandoffRules } from "../../src/core/flow-router.js";
import { RegistryService } from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

// =============================================================================
// FlowRouter — decision engine for "what does the agent do next?"
// =============================================================================
//
// Covers the four routing-decision shapes:
//   - forward (handoff rule matched + target agent for the role exists)
//   - finalize (orchestrator finished, or no rule + no orchestrator)
//   - halt (spawn failed, or addStep threw max_steps)
//   - noop (flow is no longer active)
//
// Plus the parseHandoffRules pure helper.

describe("parseHandoffRules", () => {
  it("returns [] for null / empty / invalid JSON", () => {
    expect(parseHandoffRules(null)).toEqual([]);
    expect(parseHandoffRules("")).toEqual([]);
    expect(parseHandoffRules("not json")).toEqual([]);
  });
  it("filters out malformed rules", () => {
    const raw = JSON.stringify([
      { when: "approved", toRole: "orchestrator", template: "x", intent: "y" },
      { when: 123 }, // bad shape
      "not an object",
      null,
      { when: "approved", toRole: "orchestrator" }, // missing template + intent
    ]);
    expect(parseHandoffRules(raw)).toHaveLength(1);
  });
  it("accepts a clean rule array", () => {
    const raw = JSON.stringify([
      {
        when: "changes_requested",
        toRole: "coder",
        template: "Apply: {output}",
        intent: "fix",
      },
    ]);
    const parsed = parseHandoffRules(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!).toMatchObject({
      when: "changes_requested",
      toRole: "coder",
      intent: "fix",
    });
  });
});

describe("FlowRouter", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let registry: RegistryService;
  let flows: FlowManager;
  let router: FlowRouter;
  let bus: EventBus<ForemanEventMap>;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    registry = new RegistryService(db, bus);
    flows = new FlowManager(db);
    router = new FlowRouter(flows, registry, createHeuristicClassifier());
  });
  afterEach(() => {
    sqlite.close();
  });

  function registerAgent(
    id: string,
    role: string | null,
    handoffRules?: Array<{
      when: string;
      toRole: string;
      template: string;
      intent: string;
    }>,
  ) {
    registry.register({ id, displayName: id, transport: "stdio" });
    if (role) registry.setRole(id, role);
    if (handoffRules) {
      registry.setHandoffRules(id, JSON.stringify(handoffRules));
    }
  }

  it("returns noop when the flow is not active", () => {
    registerAgent("codex", "coder");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    flows.haltFlow(flowId, "manual");
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "codex",
      output: "done",
      spawnOk: true,
    });
    expect(decision.kind).toBe("noop");
  });

  it("halts the flow when the spawn failed", () => {
    registerAgent("codex", "coder");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "codex",
      output: "Error: ENOENT",
      spawnOk: false,
    });
    expect(decision.kind).toBe("halt");
    expect(flows.get(flowId)!.status).toBe("halted");
  });

  it("forwards to a peer when a handoff rule matches the classification", () => {
    registerAgent("codex", "coder", [
      {
        when: "code_written",
        toRole: "reviewer",
        template: "Review: {summary}",
        intent: "review",
      },
    ]);
    registerAgent("claude-code", "reviewer");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "codex",
      output: "Implemented TodoController.php with full CRUD",
      spawnOk: true,
    });
    expect(decision.kind).toBe("forward");
    if (decision.kind === "forward") {
      expect(decision.targetAgent).toBe("claude-code");
      expect(decision.intent).toBe("review");
      expect(decision.prompt).toContain("Review:");
      // The new step landed in the DB.
      expect(flows.listSteps(flowId)).toHaveLength(2);
    }
  });

  it("forwards to the orchestrator when no rule matches + source is non-orchestrator", () => {
    registerAgent("codex", "coder"); // no rules
    registerAgent("hermes", "orchestrator");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "codex",
      output: "some output that doesn't match any classification",
      spawnOk: true,
    });
    expect(decision.kind).toBe("forward");
    if (decision.kind === "forward") {
      expect(decision.targetAgent).toBe("hermes");
      expect(decision.intent).toBe("summarize");
    }
  });

  it("finalizes when source IS orchestrator (orchestrator produced the summary)", () => {
    registerAgent("hermes", "orchestrator");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "hermes",
      prompt: "p",
    });
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "hermes",
      output: "Summary: all done. Tests pass.",
      spawnOk: true,
    });
    expect(decision.kind).toBe("finalize");
    expect(flows.get(flowId)!.status).toBe("completed");
    expect(flows.get(flowId)!.finalSummary).toContain("Summary");
  });

  it("finalizes when no orchestrator is registered + no rule matches", () => {
    registerAgent("codex", "coder");
    // no orchestrator registered
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "codex",
      output: "done",
      spawnOk: true,
    });
    expect(decision.kind).toBe("finalize");
    expect(flows.get(flowId)!.status).toBe("completed");
  });

  it("halts when addStep throws (max_steps ceiling exceeded)", () => {
    registerAgent("codex", "coder", [
      {
        when: "code_written",
        toRole: "reviewer",
        template: "Review: {output}",
        intent: "review",
      },
    ]);
    registerAgent("claude-code", "reviewer");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
      maxSteps: 1, // ceiling already hit by the root step
    });
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "codex",
      output: "Implemented Foo.ts",
      spawnOk: true,
    });
    expect(decision.kind).toBe("halt");
    expect(flows.get(flowId)!.status).toBe("halted");
  });

  it("does NOT pick the source agent as its own forward target", () => {
    // codex has a rule but the only registered "reviewer" IS codex
    // (degenerate setup) — router must NOT loop codex back to itself.
    registerAgent("codex", "reviewer", [
      {
        when: "approved",
        toRole: "reviewer",
        template: "again",
        intent: "review",
      },
    ]);
    registerAgent("hermes", "orchestrator");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const decision = router.routeAfterCompletion({
      flowId,
      stepId: rootStepId,
      sourceAgent: "codex",
      output: "Looks good to me, approved",
      spawnOk: true,
    });
    // Should fall through to orchestrator instead of self-loop.
    expect(decision.kind).toBe("forward");
    if (decision.kind === "forward") {
      expect(decision.targetAgent).toBe("hermes");
    }
  });
});
