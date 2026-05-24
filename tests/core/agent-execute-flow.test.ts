import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeWriteDirective } from "../../src/core/agent-execute.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import { createHeuristicClassifier } from "../../src/core/flow-classifier.js";
import { FlowManager } from "../../src/core/flow-manager.js";
import { FlowRouter } from "../../src/core/flow-router.js";
import { RegistryService } from "../../src/core/registry.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

// =============================================================================
// executeWriteDirective + flow context — end-to-end wiring of the routing
// engine into the spawn path.
// =============================================================================
//
// These tests prove the executor:
//   - completes the step on a successful spawn
//   - hands the captured output to the router
//   - calls enqueueFollowUp when the router decides "forward"
//   - marks the new step as running with the directive id
//   - skips the Telegram relay when the routing decision is "forward"
//   - relays the output when there's no flow context (preserves classic behavior)

function agent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: "codex",
    name: "Codex",
    tagline: "fixture",
    homepage: "https://example.com/",
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: "*",
    min_foreman_version: "0.1.0",
    ...overrides,
  } as AgentEntry;
}

describe("executeWriteDirective + flowContext", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let registry: RegistryService;
  let flows: FlowManager;
  let router: FlowRouter;
  let dir: string;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    const bus = new EventBus<ForemanEventMap>();
    registry = new RegistryService(db, bus);
    flows = new FlowManager(db);
    router = new FlowRouter(flows, registry, createHeuristicClassifier());
    dir = mkdtempSync(join(tmpdir(), "foreman-flow-exec-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    sqlite.close();
  });

  function makeScript(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

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

  it("forwards to a peer when the router classifies the output as a handoff trigger", async () => {
    registerAgent("codex", "coder", [
      {
        when: "code_written",
        toRole: "reviewer",
        template: "Review this: {summary}",
        intent: "review",
      },
    ]);
    registerAgent("claude-code", "reviewer");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const echo = makeScript(
      "codex.sh",
      "#!/bin/sh\necho 'Implemented TodoController.php with full CRUD'\n",
    );
    // Test stub returns null so the FK on flow_steps.directive_id ←
    // control_commands.id stays valid. In production the drain handler
    // inserts a real control_commands row and returns its auto-id.
    const enqueueFollowUp = vi.fn(async () => null);
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "build the app",
        entry: agent({ task_command_template: echo }),
        flowContext: {
          flowId,
          stepId: rootStepId,
          flowManager: flows,
          router,
          enqueueFollowUp,
        },
      },
      {},
    );
    expect(result.spawn.kind).toBe("ok");
    expect(result.routing?.kind).toBe("forward");
    expect(enqueueFollowUp).toHaveBeenCalledOnce();
    const callArgs = enqueueFollowUp.mock.calls.at(0) as
      | [
          {
            targetAgent: string;
            prompt: string;
            flowId: string;
            stepId: string;
          },
        ]
      | undefined;
    expect(callArgs).toBeDefined();
    const call = callArgs![0];
    expect(call).toMatchObject({
      targetAgent: "claude-code",
      flowId,
    });
    expect(call.prompt).toContain("Review this:");

    // The router's new step is in the DB.
    const steps = flows.listSteps(flowId);
    expect(steps).toHaveLength(2);
    const reviewStep = steps[1]!;
    expect(reviewStep.targetAgent).toBe("claude-code");
    // Executor's markStepRunning flipped the status (null directive id
    // is acceptable in the test path — see note on enqueueFollowUp).
    expect(reviewStep.status).toBe("running");
    expect(reviewStep.directiveId).toBeNull();

    // Root step transitioned to completed with a summary.
    const root = flows.getStep(rootStepId)!;
    expect(root.status).toBe("completed");
    expect(root.outputSummary).toContain("Implemented");

    // Telegram relay was SUPPRESSED (intermediate step → user shouldn't
    // see the codex output, just the final summary later).
    expect(result.outputRelay).toMatchObject({ status: "skipped" });
  });

  it("relays output to Telegram (classic behavior) when no flow context is provided", async () => {
    const echo = makeScript("echo.sh", "#!/bin/sh\necho 'done'\n");
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "x",
        entry: agent({ task_command_template: echo }),
        // no flowContext
      },
      {
        telegramBotToken: "t",
        telegramChatId: "c",
        fetchImpl: fakeFetch as unknown as typeof fetch,
      },
    );
    expect(result.spawn.kind).toBe("ok");
    expect(result.outputRelay?.status).toBe("ok");
    expect(result.routing).toBeNull();
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("marks the step failed + halts the flow on a failed spawn", async () => {
    registerAgent("codex", "coder", [
      {
        when: "code_written",
        toRole: "reviewer",
        template: "x",
        intent: "review",
      },
    ]);
    registerAgent("claude-code", "reviewer");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "codex",
      prompt: "p",
    });
    const fail = makeScript("fail.sh", "#!/bin/sh\necho 'broke' >&2\nexit 3\n");
    const enqueueFollowUp = vi.fn(async () => null);
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "x",
        entry: agent({ task_command_template: fail }),
        flowContext: {
          flowId,
          stepId: rootStepId,
          flowManager: flows,
          router,
          enqueueFollowUp,
        },
      },
      {},
    );
    expect(result.spawn.kind).toBe("failed");
    expect(result.routing?.kind).toBe("halt");
    expect(enqueueFollowUp).not.toHaveBeenCalled();
    expect(flows.get(flowId)!.status).toBe("halted");
    expect(flows.getStep(rootStepId)!.status).toBe("failed");
  });

  it("relays output (classic) when routing decision is 'finalize' — the flow ended", async () => {
    // Orchestrator finishes → router finalizes the flow. The output IS
    // the final user-facing summary, so Telegram relay should fire.
    registerAgent("hermes", "orchestrator");
    const { flowId, rootStepId } = flows.startFlow({
      goal: "x",
      rootAgent: "hermes",
      prompt: "p",
    });
    const echo = makeScript("echo.sh", "#!/bin/sh\necho 'Summary: all done'\n");
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    });
    const enqueueFollowUp = vi.fn(async () => null);
    const result = await executeWriteDirective(
      {
        agentId: "hermes",
        message: "summarize",
        entry: agent({ id: "hermes", task_command_template: echo }),
        flowContext: {
          flowId,
          stepId: rootStepId,
          flowManager: flows,
          router,
          enqueueFollowUp,
        },
      },
      {
        telegramBotToken: "t",
        telegramChatId: "c",
        fetchImpl: fakeFetch as unknown as typeof fetch,
      },
    );
    expect(result.routing?.kind).toBe("finalize");
    expect(fakeFetch).toHaveBeenCalledOnce(); // user gets the summary
    expect(enqueueFollowUp).not.toHaveBeenCalled();
    expect(flows.get(flowId)!.status).toBe("completed");
  });
});
