import { existsSync } from "node:fs";
import { Command } from "commander";
import { DbApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { ControlChannel } from "../core/control-channel.js";
import { DELEGATION_TOOL } from "../core/foreman-command.js";
import { createMediatorStack } from "../core/mediator-stack.js";
import type { JSONRPCMessage } from "../mcp/types.js";
import { cliDelegationSource, isHumanSource, orgBudgetBlock, orgDelegationVerdict } from "../core/org/guard.js";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { readForemanPid } from "../core/foreman-pidfile.js";
import { RegistryService } from "../core/registry.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { orange, red } from "./colors.js";

// =============================================================================
// `foreman write <agent> <message...>` — CLI counterpart to the chat verb.
// =============================================================================
//
// QA round 15 found that when an agent's LLM sees `foreman` on PATH it
// will sometimes try `foreman write claude-code "..."` in a shell
// instead of routing through MCP. Previously that produced
// `error: unknown command 'write'` because the CLI didn't expose the
// verb. Now it enqueues a control_commands row exactly like the chat
// path does — the `foreman start` drain handler picks it up and
// spawns/relays as usual. Output still arrives in the user's chat.
//
// Owner gating is intentionally NOT enforced here: invoking the CLI
// already requires shell access on the host, so the user IS the owner
// by construction.

export const writeCommand = new Command("write")
  .description("Send a directive to an agent. Output arrives in the user's chat.")
  .argument("<agent>", "Target agent id (e.g. codex, claude-code, openclaw).")
  .argument("<message...>", "Message body — joined with spaces if multiple tokens.")
  .action(async (agentArg: string, messageTokens: string[]) => {
    const exit = await runWrite(agentArg, messageTokens.join(" ").trim());
    process.exit(exit);
  });

export async function runWrite(
  agentArg: string,
  message: string,
): Promise<0 | 1 | 2> {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") +
        `Foreman is not initialised at ${paths.root}. Run \`foreman init\` first.`,
    );
    return 1;
  }
  const targetAgent = agentArg.toLowerCase().trim();
  if (!targetAgent || message.length === 0) {
    console.error(
      red("error: ") +
        "Usage: `foreman write <agent> <message>`. " +
        "Example: `foreman write codex review the latest PR`.",
    );
    return 2;
  }

  const db = getDb();
  try {
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    if (!registry.get(targetAgent)) {
      console.error(
        red("error: ") +
          `No agent registered with id "${targetAgent}". ` +
          `Run \`foreman agents list\` to see what's installed.`,
      );
      return 2;
    }
    // An agent Foreman spawned runs with FOREMAN_SPAWNED_BY set; when it
    // shells out to `foreman write` it is delegating, not the human.
    const source = cliDelegationSource();
    const verdict = orgDelegationVerdict(paths.orgConfigPath, source, targetAgent);
    if (verdict && !verdict.allowed) {
      console.error(
        red("error: ") +
          `blocked by the org chart: ${verdict.reason}. Hand the task to your manager or a department head.`,
      );
      return 2;
    }
    // Department budgets: an agent can't hand work into a paused department.
    if (!isHumanSource(source)) {
      const overBudget = orgBudgetBlock(db, paths.orgConfigPath, targetAgent);
      if (overBudget) {
        console.error(red("error: ") + `paused by budget: ${overBudget}. Ask the user to raise it (foreman org budget).`);
        return 2;
      }
      // The hand-off is a call from one agent to another (#656):
      // policy.yaml's can_call / cannot_call and the risk engine see it.
      const verdict = await mediateDelegation(db, paths.policyPath, source, targetAgent, message);
      if (verdict) {
        console.error(red("error: ") + `not handed to ${targetAgent}: denied by ${verdict}.`);
        return 2;
      }
    }
    const channel = new ControlChannel(db);
    const enq = channel.enqueue({
      command: "write",
      args: [targetAgent, message],
      // sourceAgent="cli" marks the row as host-shell originated (the
      // human); a spawned agent's id marks an agent-to-agent delegation.
      sourceAgent: source,
    });
    // Only `foreman start` drains the control_commands queue. When it
    // isn't running the row sits there forever and the directive
    // appears to silently fail. Detect that up front and warn — the
    // row is still enqueued (the user can `foreman start` later and it
    // will be picked up).
    const startPid = readForemanPid(paths.configDir);
    if (startPid === null) {
      console.log(
        orange("warning: ") +
          "`foreman start` is not running, so nothing will drain this " +
          "directive yet. Run `foreman start` to process it.",
      );
    }
    console.log(
      `Directive queued for ${targetAgent} (tracking id=${enq.id}). ` +
        `When \`foreman start\` is running the drain handler picks it ` +
        `up within ~1.5s and posts the agent's output to your chat.`,
    );
    return 0;
  } finally {
    closeDb();
  }
}

/** `source → target:write` through the mediator, as mcp-stdio does for
 *  `submit_command write`. Returns why it was denied, or null. */
async function mediateDelegation(
  db: ReturnType<typeof getDb>,
  policyPath: string,
  source: string,
  targetAgent: string,
  task: string,
): Promise<string | null> {
  const bus = new EventBus<ForemanEventMap>();
  const audit = new AuditLogger(db, bus);
  try {
    const { mediator } = createMediatorStack({
      db,
      bus,
      approval: new DbApprovalService(db, { bus }),
      policyPath,
      onPolicyError: (m) => process.stderr.write(`foreman write: ${m}\n`),
    });
    const outcome = await mediator.handleRequest({
      sourceAgent: source,
      targetAgent,
      targetTool: DELEGATION_TOOL,
      message: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: DELEGATION_TOOL, arguments: { task } },
      } as JSONRPCMessage,
      policyFallback: { effect: "allow", source: "org.yaml" },
    });
    return outcome.decision === "allowed" ? null : outcome.decidedBy;
  } finally {
    audit.dispose();
  }
}
