import type { Classification, OutputClassifier } from "./flow-classifier.js";
import type { FlowManager } from "./flow-manager.js";
import type { RegistryService } from "./registry.js";

// =============================================================================
// FlowRouter — decides what happens after an agent finishes a flow step
// =============================================================================
//
// Inputs:  finished step + the captured spawn output
// Outputs: a RoutingDecision the executor consumes to enqueue the next
//          directive (or finalize the flow, or escalate to the user).
//
// Decision tree:
//   1. classify(output, handoff_rule_keys_for_source_agent)
//   2. lookup the first handoff_rule on the source agent whose `when`
//      matches → forward to a peer with role = rule.toRole
//   3. no rule match + source agent is NOT orchestrator → forward to
//      orchestrator with intent=summarize so it can wrap up
//   4. source IS orchestrator (it just produced the summary) →
//      finalize the flow + emit completion event
//   5. no orchestrator registered AND no rule match → escalate to user
//      with whatever the source produced
//
// Cycle protection: FlowManager.addStep throws if the flow hit
// max_steps; the router catches + downgrades to halt.

export interface HandoffRule {
  when: Classification;
  toRole: string;
  template: string;     // Use `{output}` and `{summary}` placeholders.
  intent: string;
}

export type RoutingDecision =
  | {
      kind: "forward";
      flowId: string;
      stepId: string;        // newly inserted step (pending → caller marks running)
      targetAgent: string;
      intent: string;
      prompt: string;
    }
  | {
      kind: "finalize";
      flowId: string;
      summary: string;
    }
  | {
      kind: "halt";
      flowId: string;
      reason: string;
    }
  | {
      kind: "noop";
      reason: string;
    };

export interface RouteInput {
  flowId: string;
  stepId: string;
  sourceAgent: string;
  output: string;
  /** True when the spawn was ok; false on failed/timeout/spawn-error. */
  spawnOk: boolean;
}

export class FlowRouter {
  constructor(
    private readonly flows: FlowManager,
    private readonly registry: RegistryService,
    private readonly classifier: OutputClassifier,
  ) {}

  routeAfterCompletion(input: RouteInput): RoutingDecision {
    const flow = this.flows.get(input.flowId);
    if (!flow || flow.status !== "active") {
      return {
        kind: "noop",
        reason: `flow ${input.flowId} not active`,
      };
    }

    // Spawn failure: halt the flow with the failure context. We don't
    // try to "recover" automatically — that's a future heuristic.
    if (!input.spawnOk) {
      this.flows.haltFlow(input.flowId, `spawn failed at step ${input.stepId}`);
      return {
        kind: "halt",
        flowId: input.flowId,
        reason: "spawn failed",
      };
    }

    const sourceEntry = this.registry.get(input.sourceAgent);
    const rules = parseHandoffRules(sourceEntry?.handoffRules ?? null);
    const classification = this.classifier.classify(
      input.output,
      rules.map((r) => r.when),
    );

    const matched = rules.find((r) => r.when === classification);

    if (matched) {
      const target = this.findAgentByRole(matched.toRole, input.sourceAgent);
      if (!target) {
        // No agent for that role registered — fall through to orchestrator.
      } else {
        const prompt = renderTemplate(matched.template, {
          output: input.output,
          summary: summarize(input.output),
        });
        try {
          const stepId = this.flows.addStep({
            flowId: input.flowId,
            parentStepId: input.stepId,
            sourceAgent: input.sourceAgent,
            targetAgent: target,
            intent: matched.intent,
            prompt,
          });
          return {
            kind: "forward",
            flowId: input.flowId,
            stepId,
            targetAgent: target,
            intent: matched.intent,
            prompt,
          };
        } catch (err) {
          // max_steps reached, etc.
          const reason = err instanceof Error ? err.message : String(err);
          this.flows.haltFlow(input.flowId, reason);
          return { kind: "halt", flowId: input.flowId, reason };
        }
      }
    }

    // No matching rule. If source is the orchestrator, treat the output
    // as the final summary.
    if (sourceEntry?.role === "orchestrator") {
      this.flows.completeFlow(input.flowId, summarize(input.output, 2000));
      return {
        kind: "finalize",
        flowId: input.flowId,
        summary: summarize(input.output, 2000),
      };
    }

    // Otherwise forward to the orchestrator for summarization.
    const orchestrator = this.findAgentByRole("orchestrator", input.sourceAgent);
    if (orchestrator) {
      const prompt =
        `Aşağıdaki agent çıktısını al, kullanıcıya tek paragraflık özet hazırla:\n\n` +
        `Source: ${input.sourceAgent}\n` +
        `Goal: ${flow.goal}\n\n` +
        `Output:\n${summarize(input.output, 3500)}`;
      try {
        const stepId = this.flows.addStep({
          flowId: input.flowId,
          parentStepId: input.stepId,
          sourceAgent: input.sourceAgent,
          targetAgent: orchestrator,
          intent: "summarize",
          prompt,
        });
        return {
          kind: "forward",
          flowId: input.flowId,
          stepId,
          targetAgent: orchestrator,
          intent: "summarize",
          prompt,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.flows.haltFlow(input.flowId, reason);
        return { kind: "halt", flowId: input.flowId, reason };
      }
    }

    // No orchestrator → finalize with the raw output as the summary.
    this.flows.completeFlow(input.flowId, summarize(input.output, 2000));
    return {
      kind: "finalize",
      flowId: input.flowId,
      summary: summarize(input.output, 2000),
    };
  }

  /** Find a registered agent matching `role`. Prefer one that isn't the
   *  current source (avoid hermes→hermes). Returns the first match or
   *  null. */
  private findAgentByRole(role: string, exclude?: string): string | null {
    const all = this.registry.list();
    const candidates = all.filter(
      (a) => a.role === role && a.id !== exclude && a.status !== "blocked",
    );
    if (candidates.length === 0) return null;
    return candidates[0]!.id;
  }
}

export function parseHandoffRules(raw: string | null): HandoffRule[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is HandoffRule =>
        r != null &&
        typeof r === "object" &&
        typeof r.when === "string" &&
        typeof r.toRole === "string" &&
        typeof r.template === "string" &&
        typeof r.intent === "string",
    );
  } catch {
    return [];
  }
}

function renderTemplate(
  template: string,
  vars: { output: string; summary: string },
): string {
  return template
    .replace(/\{output\}/g, vars.output)
    .replace(/\{summary\}/g, vars.summary);
}

function summarize(text: string, max = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trim() + "…";
}
