import { existsSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import {
  findAgent,
  loadActiveRegistry,
  AgentNotInRegistryError,
} from "../core/registry-catalog.js";
import { AgentNotFoundError, RegistryService } from "../core/registry.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import {
  runAgentAddInteractive,
  runAgentAddScripted,
  type AddScriptedOptions,
} from "./agent-add.js";
import { MissingRequiredSecretsError } from "../core/agent-add-flow.js";
import { bold, dim, orange, red } from "./colors.js";
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

export const agentsCommand = new Command("agent")
  .alias("agents")
  .description(
    "Agent commands (list / add / remove / regenerate-key / show / block / unblock)",
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
  .command("add [name]")
  .description("Register a new agent (interactive when name is omitted)")
  .option(
    "--type <registryId>",
    "registry entry id (required in scripted form)",
  )
  .option("--config-path <path>", "override the registry's default config path")
  .option(
    "--skip-config",
    "do not inject the MCP snippet into the agent config",
  )
  .option(
    "--auto-install",
    "run the install command when the binary is missing",
  )
  .option("--key-out <path>", "write the new private key to this path (0600)")
  .action(
    async (
      name: string | undefined,
      options: {
        type?: string;
        configPath?: string;
        skipConfig?: boolean;
        autoInstall?: boolean;
        keyOut?: string;
      },
    ) => {
      const registry = getRegistry();
      const db = getDb();
      try {
        let exit = 0;
        if (!name && !options.type) {
          exit = await runAgentAddInteractive({ registry, db });
        } else if (name && options.type) {
          const scripted: AddScriptedOptions = {
            type: options.type,
            configPath: options.configPath,
            skipConfig: options.skipConfig,
            autoInstall: options.autoInstall,
            keyOut: options.keyOut,
          };
          exit = await runAgentAddScripted(name, scripted, { registry, db });
        } else {
          console.error(
            red("error: ") +
              "scripted form requires both <name> and --type, e.g. foreman agent add hermes --type hermes",
          );
          exit = 1;
        }
        process.exitCode = exit;
      } catch (err) {
        handleAgentError(err);
      } finally {
        closeDb();
      }
    },
  );

agentsCommand
  .command("remove <name>")
  .description("Remove an agent (hard delete; re-add issues a fresh keypair)")
  .option("--yes", "skip confirmation prompt")
  .action(async (name: string, options: { yes?: boolean }) => {
    const registry = getRegistry();
    try {
      if (
        !options.yes &&
        !(await confirmYes(`Remove agent "${name}"? [y/N]`))
      ) {
        console.log("(cancelled)");
        return;
      }
      registry.remove(name);
      console.log(`agent ${name} removed`);
    } catch (err) {
      handleAgentError(err);
    } finally {
      closeDb();
    }
  });

agentsCommand
  .command("regenerate-key <name>")
  .description("Rotate the agent's Ed25519 keypair")
  .option("--out <path>", "write the new private key to this path (0600)")
  .action((name: string, options: { out?: string }) => {
    const registry = getRegistry();
    try {
      const { privateKey } = registry.regenerateKey(name);
      if (options.out) {
        writeFileSync(options.out, privateKey, { mode: 0o600 });
        console.log(
          `agent ${name} key rotated; private key written to ${options.out}`,
        );
      } else {
        console.log(orange("new private key (printed once):"));
        console.log(privateKey.toString("hex"));
      }
    } catch (err) {
      handleAgentError(err);
    } finally {
      closeDb();
    }
  });

agentsCommand
  .command("show <name>")
  .description("Print the agent row plus its MCP config snippet")
  .option("--json", "output JSON")
  .action((name: string, options: { json?: boolean }) => {
    const registry = getRegistry();
    try {
      const agent = registry.get(name);
      if (!agent) throw new AgentNotFoundError(name);
      const { doc } = loadActiveRegistry();
      const registryId =
        typeof agent.metadata?.registryId === "string"
          ? agent.metadata.registryId
          : null;
      const registryEntry = registryId ? safeFindAgent(doc, registryId) : null;
      if (options.json) {
        const payload = renderAgentJson(agent) as Record<string, unknown>;
        process.stdout.write(
          JSON.stringify(
            {
              ...payload,
              mcpSnippet: registryEntry
                ? buildMcpSnippet(agent.id, registryEntry).json
                : null,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }
      console.log(renderAgentLine(agent));
      console.log(
        `  ${dim("registry:")}    ${registryId ?? dim("(custom / unknown)")}`,
      );
      if (registryEntry) {
        console.log("");
        console.log(bold("MCP snippet:"));
        console.log(buildMcpSnippet(agent.id, registryEntry).yaml);
      }
    } catch (err) {
      handleAgentError(err);
    } finally {
      closeDb();
    }
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

function safeFindAgent(
  doc: ReturnType<typeof loadActiveRegistry>["doc"],
  id: string,
): ReturnType<typeof findAgent> | null {
  try {
    return findAgent(doc, id);
  } catch (err) {
    if (err instanceof AgentNotInRegistryError) return null;
    throw err;
  }
}

async function confirmYes(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((res) => {
    rl.question(`${prompt} `, (answer) => {
      rl.close();
      res(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function handleAgentError(err: unknown): void {
  if (err instanceof AgentNotFoundError) {
    console.error(red("error: ") + `no agent with id ${err.agentId}`);
    process.exit(1);
  }
  if (err instanceof MissingRequiredSecretsError) {
    console.error(
      red("error: ") +
        err.message +
        " — add them via 'foreman secrets add <name>' first.",
    );
    process.exit(1);
  }
  throw err;
}
