import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { ForemanDb } from "../db/client.js";
import {
  type Flow,
  type FlowStep,
  flowSteps,
  flows,
} from "../db/schema.js";

// =============================================================================
// FlowManager — DB-backed flow lifecycle store
// =============================================================================
//
// One row in `flows` per user-initiated multi-step goal. Each
// agent-to-agent handoff inserts a `flow_steps` row that references its
// parent — gives the full tree the CLI / TUI / audit log can render.
//
// Lifecycle:
//   - startFlow(goal, rootAgent, prompt) → returns flowId + rootStepId
//   - markStepRunning(stepId, directiveId)  ← drain handler hooks the
//     control_commands.id so the step ↔ spawn is traceable
//   - completeStep(stepId, classification, summary)  ← post-spawn hook
//     records the classifier verdict + a short summary for the tree view
//   - failStep(stepId, reason)
//   - addStep(...)  ← FlowRouter calls when forwarding to a peer
//   - completeFlow(flowId, summary)
//   - haltFlow(flowId, reason)
//
// All times in ms epoch. IDs are ULIDs (sortable, URL-safe).

export interface StartFlowInput {
  goal: string;
  rootAgent: string;
  prompt: string;
  initiator?: string;
  maxSteps?: number;
}

export interface AddStepInput {
  flowId: string;
  parentStepId: string;
  sourceAgent: string;
  targetAgent: string;
  intent: string;
  prompt: string;
}

export class FlowError extends Error {}

export class FlowManager {
  constructor(
    private readonly db: ForemanDb,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Open a new flow and seed it with the root user-initiated step.
   *  Returns both ids so callers can attach the spawn directly to the
   *  root step. */
  startFlow(input: StartFlowInput): { flowId: string; rootStepId: string } {
    const flowId = ulid();
    const now = this.now();
    this.db
      .insert(flows)
      .values({
        id: flowId,
        startedAt: now,
        status: "active",
        initiator: input.initiator ?? null,
        goal: input.goal,
        currentHolder: input.rootAgent,
        costUsd: 0,
        maxSteps: input.maxSteps ?? 10,
        stepCount: 1,
      })
      .run();
    const rootStepId = ulid();
    this.db
      .insert(flowSteps)
      .values({
        id: rootStepId,
        flowId,
        parentStepId: null,
        stepOrder: 1,
        sourceAgent: null,
        targetAgent: input.rootAgent,
        intent: "implement",
        prompt: input.prompt,
        status: "pending",
        startedAt: now,
      })
      .run();
    return { flowId, rootStepId };
  }

  /** Append a new step under `parentStepId`. The router calls this
   *  immediately after classifying a completed step's output to record
   *  the next handoff. The returned step is `pending` until the drain
   *  handler attaches a directive_id via `markStepRunning`. */
  addStep(input: AddStepInput): string {
    const flow = this.requireFlow(input.flowId);
    if (flow.status !== "active") {
      throw new FlowError(
        `Cannot add step: flow ${input.flowId} is ${flow.status}`,
      );
    }
    if (flow.stepCount >= flow.maxSteps) {
      throw new FlowError(
        `Cannot add step: flow ${input.flowId} hit max_steps=${flow.maxSteps}`,
      );
    }
    const stepId = ulid();
    const now = this.now();
    const nextOrder = flow.stepCount + 1;
    this.db
      .insert(flowSteps)
      .values({
        id: stepId,
        flowId: input.flowId,
        parentStepId: input.parentStepId,
        stepOrder: nextOrder,
        sourceAgent: input.sourceAgent,
        targetAgent: input.targetAgent,
        intent: input.intent,
        prompt: input.prompt,
        status: "pending",
        startedAt: now,
      })
      .run();
    this.db
      .update(flows)
      .set({ stepCount: nextOrder, currentHolder: input.targetAgent })
      .where(eq(flows.id, input.flowId))
      .run();
    return stepId;
  }

  /** Wire the control_commands.id into the step + flip to running. */
  markStepRunning(stepId: string, directiveId: number | null): void {
    this.db
      .update(flowSteps)
      .set({ status: "running", directiveId })
      .where(eq(flowSteps.id, stepId))
      .run();
  }

  /** Record the classifier verdict + a short human summary on a
   *  completed step. Caller is the post-spawn hook in
   *  executeWriteDirective. */
  completeStep(
    stepId: string,
    classification: string | null,
    summary: string | null,
  ): void {
    const now = this.now();
    this.db
      .update(flowSteps)
      .set({
        status: "completed",
        outputClassification: classification,
        outputSummary: summary,
        completedAt: now,
      })
      .where(eq(flowSteps.id, stepId))
      .run();
  }

  failStep(stepId: string, summary: string | null): void {
    const now = this.now();
    this.db
      .update(flowSteps)
      .set({
        status: "failed",
        outputSummary: summary,
        completedAt: now,
      })
      .where(eq(flowSteps.id, stepId))
      .run();
  }

  /** Mark the flow successful. `summary` is the orchestrator's final
   *  user-facing message (rendered by the notification bridge). */
  completeFlow(flowId: string, summary: string): void {
    const now = this.now();
    this.db
      .update(flows)
      .set({
        status: "completed",
        endedAt: now,
        finalSummary: summary,
        currentHolder: null,
      })
      .where(and(eq(flows.id, flowId), eq(flows.status, "active")))
      .run();
  }

  /** Halt the flow (cycle ceiling, manual stop, cost ceiling, etc.). */
  haltFlow(flowId: string, reason: string): void {
    const now = this.now();
    this.db
      .update(flows)
      .set({
        status: "halted",
        endedAt: now,
        finalSummary: reason,
        currentHolder: null,
      })
      .where(and(eq(flows.id, flowId), eq(flows.status, "active")))
      .run();
  }

  get(flowId: string): Flow | null {
    const row = this.db
      .select()
      .from(flows)
      .where(eq(flows.id, flowId))
      .get();
    return row ?? null;
  }

  getStep(stepId: string): FlowStep | null {
    const row = this.db
      .select()
      .from(flowSteps)
      .where(eq(flowSteps.id, stepId))
      .get();
    return row ?? null;
  }

  /** All steps in a flow, sorted by step_order. */
  listSteps(flowId: string): FlowStep[] {
    return this.db
      .select()
      .from(flowSteps)
      .where(eq(flowSteps.flowId, flowId))
      .all()
      .sort((a, b) => a.stepOrder - b.stepOrder);
  }

  listActive(): Flow[] {
    return this.db
      .select()
      .from(flows)
      .where(eq(flows.status, "active"))
      .all();
  }

  list(): Flow[] {
    return this.db
      .select()
      .from(flows)
      .all()
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Look up the most recent in-flight step for an agent. Used by the
   *  post-spawn hook when the drain handler only knows the target
   *  agentId (not the step id) — we find "which step did we just
   *  finish for this agent". Returns null when nothing matches. */
  findRunningStepForAgent(agentId: string): FlowStep | null {
    const candidates = this.db
      .select()
      .from(flowSteps)
      .where(
        and(eq(flowSteps.targetAgent, agentId), eq(flowSteps.status, "running")),
      )
      .all();
    if (candidates.length === 0) return null;
    // Most-recent wins (multiple shouldn't happen with serial routing
    // but be defensive).
    return candidates.sort((a, b) => b.startedAt - a.startedAt)[0]!;
  }

  private requireFlow(flowId: string): Flow {
    const flow = this.get(flowId);
    if (!flow) throw new FlowError(`Flow not found: ${flowId}`);
    return flow;
  }
}
