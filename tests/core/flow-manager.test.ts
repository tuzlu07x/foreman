import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlowError, FlowManager } from "../../src/core/flow-manager.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

// =============================================================================
// FlowManager — DB-backed flow lifecycle store.
// =============================================================================
//
// Covers the CRUD surface the FlowRouter + drain handler call:
// startFlow, addStep, markStepRunning, completeStep, completeFlow,
// haltFlow, listSteps, findRunningStepForAgent, max_steps protection.

describe("FlowManager", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let flows: FlowManager;
  let now = 1_000_000;
  const tick = (): number => {
    now += 1000;
    return now;
  };

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    now = 1_000_000;
    flows = new FlowManager(db, () => now);
  });
  afterEach(() => {
    sqlite.close();
  });

  it("startFlow inserts both the flow and root step", () => {
    const { flowId, rootStepId } = flows.startFlow({
      goal: "implement to-do-app",
      rootAgent: "codex",
      prompt: "build the app",
      initiator: "user:42",
    });
    expect(flowId).toMatch(/^[0-9A-Z]{26}$/);
    expect(rootStepId).toMatch(/^[0-9A-Z]{26}$/);

    const flow = flows.get(flowId);
    expect(flow).toMatchObject({
      id: flowId,
      goal: "implement to-do-app",
      currentHolder: "codex",
      status: "active",
      stepCount: 1,
      initiator: "user:42",
    });
    const steps = flows.listSteps(flowId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!).toMatchObject({
      id: rootStepId,
      stepOrder: 1,
      sourceAgent: null,            // root = user-initiated
      targetAgent: "codex",
      intent: "implement",
      status: "pending",
    });
  });

  it("addStep appends a child step and updates currentHolder + stepCount", () => {
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const stepId = flows.addStep({
      flowId,
      parentStepId: rootStepId,
      sourceAgent: "codex",
      targetAgent: "claude-code",
      intent: "review",
      prompt: "review this",
    });
    const step = flows.getStep(stepId);
    expect(step).toMatchObject({
      flowId,
      parentStepId: rootStepId,
      stepOrder: 2,
      sourceAgent: "codex",
      targetAgent: "claude-code",
      intent: "review",
      status: "pending",
    });
    expect(flows.get(flowId)!.stepCount).toBe(2);
    expect(flows.get(flowId)!.currentHolder).toBe("claude-code");
  });

  it("addStep throws when the flow hit max_steps (cycle protection)", () => {
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
      maxSteps: 3,
    });
    let parent = rootStepId;
    // Already 1 step from startFlow. Add 2 more to hit ceiling of 3.
    parent = flows.addStep({
      flowId,
      parentStepId: parent,
      sourceAgent: "codex",
      targetAgent: "claude-code",
      intent: "review",
      prompt: "1",
    });
    parent = flows.addStep({
      flowId,
      parentStepId: parent,
      sourceAgent: "claude-code",
      targetAgent: "codex",
      intent: "fix",
      prompt: "2",
    });
    expect(() =>
      flows.addStep({
        flowId,
        parentStepId: parent,
        sourceAgent: "codex",
        targetAgent: "claude-code",
        intent: "review",
        prompt: "3 (over the ceiling)",
      }),
    ).toThrow(FlowError);
  });

  it("addStep refuses when the flow is no longer active", () => {
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    flows.completeFlow(flowId, "done");
    expect(() =>
      flows.addStep({
        flowId,
        parentStepId: rootStepId,
        sourceAgent: "codex",
        targetAgent: "claude-code",
        intent: "review",
        prompt: "after-the-fact",
      }),
    ).toThrow(FlowError);
  });

  it("markStepRunning + completeStep transition the step state", () => {
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    flows.markStepRunning(rootStepId, null);
    expect(flows.getStep(rootStepId)).toMatchObject({
      status: "running",
      directiveId: null,
    });
    tick();
    flows.completeStep(rootStepId, "code_written", "wrote 3 files");
    expect(flows.getStep(rootStepId)).toMatchObject({
      status: "completed",
      outputClassification: "code_written",
      outputSummary: "wrote 3 files",
    });
    // Flow itself stays active — only the step terminated.
    void flowId;
    expect(flows.getStep(rootStepId)!.completedAt).toBeGreaterThan(
      flows.getStep(rootStepId)!.startedAt,
    );
  });

  it("failStep records the failure outcome", () => {
    const { rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    tick();
    flows.failStep(rootStepId, "spawn-error: ENOENT");
    expect(flows.getStep(rootStepId)).toMatchObject({
      status: "failed",
      outputSummary: "spawn-error: ENOENT",
    });
  });

  it("completeFlow flips status + sets endedAt + finalSummary, only once", () => {
    const { flowId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    tick();
    flows.completeFlow(flowId, "shipped it");
    const flow = flows.get(flowId)!;
    expect(flow.status).toBe("completed");
    expect(flow.finalSummary).toBe("shipped it");
    expect(flow.endedAt).toBeGreaterThan(flow.startedAt);
    // Second completeFlow is a no-op (the WHERE clause requires status=active).
    flows.completeFlow(flowId, "twice");
    expect(flows.get(flowId)!.finalSummary).toBe("shipped it");
  });

  it("haltFlow records the halt reason in finalSummary", () => {
    const { flowId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    flows.haltFlow(flowId, "max_steps exceeded");
    const flow = flows.get(flowId)!;
    expect(flow.status).toBe("halted");
    expect(flow.finalSummary).toBe("max_steps exceeded");
  });

  it("listSteps returns steps in step_order", () => {
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const s2 = flows.addStep({
      flowId,
      parentStepId: rootStepId,
      sourceAgent: "codex",
      targetAgent: "claude-code",
      intent: "review",
      prompt: "r",
    });
    const s3 = flows.addStep({
      flowId,
      parentStepId: s2,
      sourceAgent: "claude-code",
      targetAgent: "codex",
      intent: "fix",
      prompt: "f",
    });
    const steps = flows.listSteps(flowId);
    expect(steps.map((s) => s.id)).toEqual([rootStepId, s2, s3]);
  });

  it("findRunningStepForAgent returns the most recent running step", () => {
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    flows.markStepRunning(rootStepId, null);
    const found = flows.findRunningStepForAgent("codex");
    expect(found?.id).toBe(rootStepId);
    // Once completed, it's no longer findable.
    flows.completeStep(rootStepId, "code_written", "done");
    expect(flows.findRunningStepForAgent("codex")).toBeNull();
    void flowId;
  });

  it("list returns all flows sorted by startedAt desc", () => {
    const a = flows.startFlow({
      goal: "first",
      rootAgent: "codex",
      prompt: "1",
    });
    tick();
    const b = flows.startFlow({
      goal: "second",
      rootAgent: "codex",
      prompt: "2",
    });
    const ordered = flows.list();
    expect(ordered.map((f) => f.id)).toEqual([b.flowId, a.flowId]);
  });

  it("listActive filters out completed + halted flows", () => {
    const a = flows.startFlow({
      goal: "a",
      rootAgent: "codex",
      prompt: "1",
    });
    const b = flows.startFlow({
      goal: "b",
      rootAgent: "codex",
      prompt: "2",
    });
    const c = flows.startFlow({
      goal: "c",
      rootAgent: "codex",
      prompt: "3",
    });
    flows.completeFlow(a.flowId, "done");
    flows.haltFlow(c.flowId, "stopped");
    expect(flows.listActive().map((f) => f.id)).toEqual([b.flowId]);
  });
});
