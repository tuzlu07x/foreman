import { existsSync } from "node:fs";
import { Command } from "commander";
import { ControlChannel } from "../core/control-channel.js";
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
    const channel = new ControlChannel(db);
    const enq = channel.enqueue({
      command: "write",
      args: [targetAgent, message],
      // sourceAgent="cli" marks the row as host-shell originated. The
      // drain handler treats it the same as a chat-routed write; only
      // the audit log uses this for "where did this come from".
      sourceAgent: "cli",
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
