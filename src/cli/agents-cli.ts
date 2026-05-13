import { existsSync } from "node:fs";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import { AgentNotFoundError, RegistryService } from "../core/registry.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";
import { renderAgentJson, renderAgentLine } from "./render.js";

function getRegistry(): RegistryService {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") + `Foreman is not initialised. Run 'foreman init' first.`,
    );
    process.exit(1);
  }
  return new RegistryService(getDb(), bus);
}

export const agentsCommand = new Command("agents").description(
  "Agents commands (list / block / unblock)",
);

agentsCommand
  .command("list", { isDefault: true })
  .description("List registered agents")
  .option("--json", "output JSON")
  .action((options: { json?: boolean }) => {
    const registry = getRegistry();
    const rows = registry.list();
    if (options.json) {
      process.stdout.write(
        JSON.stringify(rows.map(renderAgentJson), null, 2) + "\n",
      );
    } else if (rows.length === 0) {
      console.log("(no agents registered)");
    } else {
      for (const row of rows) console.log(renderAgentLine(row));
    }
    closeDb();
  });

agentsCommand
  .command("block <agentId>")
  .description("Mark an agent as blocked")
  .action((agentId: string) => {
    const registry = getRegistry();
    try {
      registry.block(agentId);
      console.log(`agent ${agentId} blocked`);
    } catch (err) {
      handleAgentError(err);
    }
    closeDb();
  });

agentsCommand
  .command("unblock <agentId>")
  .description("Restore a blocked agent to active")
  .action((agentId: string) => {
    const registry = getRegistry();
    try {
      registry.unblock(agentId);
      console.log(`agent ${agentId} unblocked`);
    } catch (err) {
      handleAgentError(err);
    }
    closeDb();
  });

function handleAgentError(err: unknown): void {
  if (err instanceof AgentNotFoundError) {
    console.error(red("error: ") + `no agent with id ${err.agentId}`);
    process.exit(1);
  }
  throw err;
}
