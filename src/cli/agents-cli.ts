import { existsSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import {
  findAgent,
  loadActiveRegistry,
  AgentNotInRegistryError,
} from "../core/registry-catalog.js";
import {
  AgentNotFoundError,
  RegistryService,
  type RegisteredAgent,
} from "../core/registry.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  checkAgentUpdates,
  type AgentUpdateStatus,
} from "../core/agent-update-check.js";
import {
  detectInstall,
  preferredUninstallCommand,
  runInstall,
  runUninstall,
} from "../core/agent-install.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import {
  runAgentAddInteractive,
  runAgentAddScripted,
  type AddScriptedOptions,
} from "./agent-add.js";
import { MissingRequiredSecretsError } from "../core/agent-add-flow.js";
import { bold, dim, green, orange, red } from "./colors.js";
import { renderAgentJson, renderAgentLine } from "./render.js";
import { requireConfirm } from "./require-confirm.js";

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
    "Agent commands (list / add / remove / regenerate-key / show / update / block / unblock / disable / enable)",
  );

agentsCommand
  .command("list", { isDefault: true })
  .description("List registered agents (including disabled + blocked)")
  .option("--json", "output JSON")
  .option("--active-only", "show only agents currently accepting requests")
  .action((options: { json?: boolean; activeOnly?: boolean }) => {
    const registry = getRegistry();
    const rows = options.activeOnly ? registry.list() : registry.listAll();
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
    "--skip-projection",
    "do not write Foreman-stored secrets into the agent's env/config files (#222 / #223)",
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
        skipProjection?: boolean;
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
            skipProjection: options.skipProjection,
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
  .description(
    "Remove an agent (hard delete + uninstall its binary; re-add issues a fresh keypair)",
  )
  .option("--yes", "skip confirmation prompt")
  .option(
    "--keep-binary",
    "remove only the Foreman registration; leave the agent binary installed",
  )
  .action(
    async (
      name: string,
      options: { yes?: boolean; keepBinary?: boolean },
    ) => {
      const registry = getRegistry();
      try {
        const agent = registry.get(name);
        if (!agent) throw new AgentNotFoundError(name);
        const ok = await requireConfirm({
          yes: options.yes,
          question: `Remove agent "${name}"?`,
          noun: `remove "${name}"`,
        });
        if (!ok) {
          console.log("(cancelled)");
          return;
        }
        const { doc } = loadActiveRegistry();
        const registryId =
          typeof agent.metadata?.registryId === "string"
            ? agent.metadata.registryId
            : null;
        const entry = registryId ? safeFindAgent(doc, registryId) : null;
        registry.remove(name);
        console.log(`${green("✓")} agent ${name} removed`);
        if (!options.keepBinary && entry) {
          // #357 — detect HOW the binary got installed, then pick the
          // uninstall command that matches. Without this, OpenClaw (brew
          // on the user's box, `brew: null` in registry) silently no-ops.
          const detection = detectInstall(entry.install);
          const uninstallCmd = preferredUninstallCommand(
            entry.install,
            detection,
          );
          if (uninstallCmd) {
            console.log(orange(`uninstalling ${entry.name} (${uninstallCmd})…`));
            const result = await runUninstall({
              install: entry.install,
              detection,
              onLine: (line) => console.log(`  ${dim(line)}`),
            });
            if (result.ok) {
              console.log(`${green("✓")} ${entry.name} uninstalled`);
            } else {
              console.error(
                red("warn: ") +
                  `uninstall failed (exit ${result.exitCode}). Run manually: ${result.manualCommand}`,
              );
            }
          } else if (entry.install.script) {
            console.log(
              orange("note: ") +
                `${entry.name} was installed via a script — Foreman can't auto-uninstall. ` +
                `Remove the ${entry.install.binary ?? entry.id} binary manually (try the installer's --uninstall flag).`,
            );
          }
        }
      } catch (err) {
        handleAgentError(err);
      } finally {
        closeDb();
      }
    },
  );

agentsCommand
  .command("regenerate-key <name>")
  .description("Rotate the agent's Ed25519 keypair")
  .option("--out <path>", "write the new private key to this path (0600)")
  .option("--yes", "skip confirmation prompt")
  .action(async (name: string, options: { out?: string; yes?: boolean }) => {
    const registry = getRegistry();
    try {
      const agent = registry.get(name);
      if (!agent) throw new AgentNotFoundError(name);
      // Rotating invalidates the old key immediately — every running session
      // authenticating with it starts failing. Require confirmation (#272).
      const ok = await requireConfirm({
        yes: options.yes,
        question: `Rotate ${name}'s keypair? Old key is invalidated immediately.`,
        noun: `regenerate-key for "${name}"`,
      });
      if (!ok) {
        console.log("(cancelled)");
        return;
      }
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
      if (agent.llmProvider) {
        console.log(`  ${dim("llm:")}         ${agent.llmProvider}`);
      }
      if (agent.responsibilityNote) {
        console.log(
          `  ${dim("note:")}        ${agent.responsibilityNote}`,
        );
      }
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
  .command("update [name]")
  .description(
    "Upgrade an agent's npm package (omit name or pass 'all' for every agent)",
  )
  .action(async (name: string | undefined) => {
    const registry = getRegistry();
    try {
      const target = name ?? "all";
      const agents = registry.list();
      const { doc } = loadActiveRegistry();
      if (target === "all") {
        await runAgentUpdateAll(agents, doc);
      } else {
        const agent = registry.get(target);
        if (!agent) throw new AgentNotFoundError(target);
        const exit = await runAgentUpdateOne(agent, doc, { force: true });
        process.exitCode = exit;
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

agentsCommand
  .command("disable <agentId>")
  .description("Temporarily pause an agent without removing its config")
  .action((agentId: string) => {
    const registry = getRegistry();
    try {
      registry.disable(agentId);
      console.log(`agent ${agentId} disabled`);
    } catch (err) {
      handleAgentError(err);
    }
    closeDb();
  });

agentsCommand
  .command("enable <agentId>")
  .description("Resume a previously disabled agent")
  .action((agentId: string) => {
    const registry = getRegistry();
    try {
      registry.enable(agentId);
      console.log(`agent ${agentId} enabled`);
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

async function runAgentUpdateOne(
  agent: RegisteredAgent,
  doc: ReturnType<typeof loadActiveRegistry>["doc"],
  options: { force: boolean },
): Promise<number> {
  const registryId =
    typeof agent.metadata?.registryId === "string"
      ? agent.metadata.registryId
      : null;
  if (!registryId) {
    console.error(
      red("error: ") +
        `agent ${agent.id} has no registry mapping (no install command known)`,
    );
    return 1;
  }
  const entry = safeFindAgent(doc, registryId);
  if (!entry) {
    console.error(
      red("error: ") +
        `registry entry "${registryId}" not found — run 'foreman registry update' first`,
    );
    return 1;
  }
  if (!entry.install.npm && !entry.install.brew) {
    // Script-installed agents (Hermes, OpenClaw) — there's no auto-update
    // command; tell the user how to re-run their installer instead of erroring.
    if (entry.install.script) {
      console.log(
        orange("note: ") +
          `${entry.name} installs via a script. Foreman won't auto-run it; re-run manually: ` +
          `curl -fsSL ${entry.install.script} | bash`,
      );
      return 0;
    }
    console.error(
      red("error: ") +
        `registry entry "${registryId}" has no install command (bring-your-own binary)`,
    );
    return 1;
  }

  if (!options.force) {
    const [status] = await checkAgentUpdates([agent], doc, {
      cacheTtlMs: 0,
    }).catch(() => [undefined as AgentUpdateStatus | undefined]);
    if (status && !status.hasUpdate && status.current !== null) {
      console.log(`${green("✓")} ${agent.id} is up to date (v${status.current})`);
      return 0;
    }
  }

  console.log(orange(`updating ${agent.id} (${entry.install.npm})…`));
  const result = await runInstall({
    install: entry.install,
    onLine: (line) => console.log(`  ${dim(line)}`),
  });
  if (!result.ok) {
    console.error(
      red("error: ") +
        `update failed (exit ${result.exitCode}). Manual command: ${result.manualCommand}`,
    );
    return 1;
  }
  console.log(`${green("✓")} ${agent.id} updated`);
  return 0;
}

async function runAgentUpdateAll(
  agents: RegisteredAgent[],
  doc: ReturnType<typeof loadActiveRegistry>["doc"],
): Promise<void> {
  if (agents.length === 0) {
    console.log("(no agents registered)");
    return;
  }
  let firstFailure: number | null = null;
  for (const agent of agents) {
    const exit = await runAgentUpdateOne(agent, doc, { force: false });
    if (exit !== 0 && firstFailure === null) firstFailure = exit;
  }
  process.exitCode = firstFailure ?? 0;
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
