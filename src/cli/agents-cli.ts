import { catalogEntryFor, isInstance, supportsInstances } from "../core/agent-instance.js";
import { loadOrg, type RoleCapability } from "../core/org/org.js";
import { claudeHookInstalled, taskPermissions } from "../core/task-permissions.js";
import { existsSync, writeFileSync } from "node:fs";
import { Command, Option } from "commander";
import { bus } from "../core/event-bus.js";
import {
  findAgent,
  loadActiveRegistry,
  AgentNotInRegistryError,
  type AgentEntry,
} from "../core/registry-catalog.js";
import {
  AgentNotFoundError,
  RegistryService,
  type RegisteredAgent,
} from "../core/registry.js";
import {
  DEFAULT_PRETOOLUSE_MATCHER,
  defaultHookCommand,
  installPreToolUseHook,
  projectSettingsPath,
  uninstallPreToolUseHook,
} from "../core/agent-hook.js";
import { buildMcpSnippet, snippetForDisplay } from "../core/agent-mcp-snippet.js";
import {
  agentTokenSecretName,
  hasAgentToken,
  InvalidTokenAgentIdError,
  revokeAgentToken,
} from "../core/agent-token.js";
import {
  describeWiringError,
  rewireAgent,
  unwireAgent,
  wiringDelivered,
  WiringParseError,
} from "../core/agent-wiring.js";
import { UnsafeTokenPathError } from "../core/token-file-safety.js";
import { SecretStore } from "../core/secret-store.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
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
import {
  checkNodeEngine,
  describeNodeEngineMismatch,
  resolveInstallerNodeVersion,
} from "../core/node-engines.js";
import {
  applyPermissions,
  DEFAULT_PERMISSIONS,
  resolveAgentSettingsPath,
} from "../core/agent-permissions.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import {
  logWiring,
  runAgentAddInteractive,
  runAgentAddScripted,
  type AddScriptedOptions,
} from "./agent-add.js";
import {
  foremanInstallRecord,
  MissingRequiredSecretsError,
  pickMcpConfigPath,
} from "../core/agent-add-flow.js";
import { bold, dim, green, orange, red } from "./colors.js";
import { renderAgentJson, renderAgentLine, renderPublicKeyJson } from "./render.js";
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
    "Agent commands (list / add / remove / rewire / token / regenerate-key / show / update / block / unblock / disable / enable)",
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
    "registry entry id (defaults to <name> when that is a registry id)",
  )
  .option("--config-path <path>", "override the registry's default config path")
  .option(
    "--skip-config",
    "do not inject the MCP snippet into the agent config",
  )
  .option(
    "--skip-projection",
    "do not write Foreman-stored secrets into the agent's env/config files",
  )
  .option(
    "--auto-install",
    "run the install command when the binary is missing",
  )
  .option("--key-out <path>", "write the new private key to this path (0600)")
  .option(
    "--token-out <path>",
    "also write the agent's identity token to this path (0600), for wiring it by hand",
  )
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
        tokenOut?: string;
      },
    ) => {
      const registry = getRegistry();
      const db = getDb();
      try {
        let exit = 0;
        // `foreman agent add claude-code`: a registry id is its own type
        // (#657), as the README's quick start assumes.
        const type =
          options.type ??
          (name && loadActiveRegistry().doc.agents.some((a) => a.id === name)
            ? name
            : undefined);
        if (!name && !options.type) {
          exit = await runAgentAddInteractive({ registry, db });
        } else if (name && type) {
          const scripted: AddScriptedOptions = {
            type,
            configPath: options.configPath,
            skipConfig: options.skipConfig,
            skipProjection: options.skipProjection,
            autoInstall: options.autoInstall,
            keyOut: options.keyOut,
            tokenOut: options.tokenOut,
          };
          exit = await runAgentAddScripted(name, scripted, { registry, db });
        } else {
          console.error(
            red("error: ") +
              (name
                ? `"${name}" is not a registry id, so say which agent it is: foreman agent add ${name} --type <registry-id> (see 'foreman registry list')`
                : "--type needs an agent name, e.g. foreman agent add my-hermes --type hermes"),
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
    "Unregister an agent, revoke its key and token, and remove Foreman's MCP entry (and hook) from its config (its binary stays installed; re-add issues a fresh keypair)",
  )
  .option("--yes", "skip confirmation prompt")
  .option(
    "--uninstall",
    "also uninstall the agent's binary, if Foreman installed it (npm / brew)",
  )
  // Keeping the binary is the default now; the flag stays so scripts that
  // pass it keep working.
  .addOption(new Option("--keep-binary").hideHelp())
  .action(
    async (
      name: string,
      options: { yes?: boolean; uninstall?: boolean; keepBinary?: boolean },
    ) => {
      const registry = getRegistry();
      try {
        const agent = registry.get(name);
        if (!agent) throw new AgentNotFoundError(name);
        if (options.uninstall && options.keepBinary) {
          console.error(red("error: ") + "--uninstall and --keep-binary contradict each other.");
          process.exitCode = 1;
          return;
        }
        const { doc } = loadActiveRegistry();
        const registryId =
          typeof agent.metadata?.registryId === "string"
            ? agent.metadata.registryId
            : null;
        const entry = registryId ? safeFindAgent(doc, registryId) : null;
        const label = entry?.name ?? name;
        const installRecord = foremanInstallRecord(agent.metadata);
        // Only an actual uninstall looks at the machine (detection can
        // shell out to `npm prefix -g`); the messages use the registry's
        // command.
        const detection =
          options.uninstall && entry ? detectInstall(entry.install) : undefined;
        const uninstallCmd = entry
          ? preferredUninstallCommand(entry.install, detection)
          : null;
        // #657 — Foreman only uninstalls what it installed, and only when
        // asked. Refuse before changing anything, so the user isn't left
        // with half of what they asked for.
        if (options.uninstall && (!installRecord || !entry)) {
          console.error(
            red("error: ") +
              `Foreman didn't install ${label}, so it won't uninstall it (it may be your own install).`,
          );
          console.error(
            `  → Run 'foreman agent remove ${name}' to unregister it` +
              (uninstallCmd ? `, then uninstall it yourself: ${uninstallCmd}` : "."),
          );
          process.exitCode = 1;
          return;
        }
        const what = options.uninstall
          ? `Foreman unregisters it, revokes its key and identity token, removes its foreman MCP entry, then uninstalls ${label}` +
            (uninstallCmd ? ` (${uninstallCmd})` : "") +
            "."
          : `Foreman unregisters it, revokes its key and identity token and removes its foreman MCP entry. ${label} stays installed.`;
        const ok = await requireConfirm({
          yes: options.yes,
          question: `Remove agent "${name}"? ${what}`,
          noun: `remove "${name}"`,
        });
        if (!ok) {
          console.log("(cancelled)");
          return;
        }
        registry.remove(name);
        // A removed agent's token must not keep proving it (#618).
        revokeAgentToken(getTokenStore(), name);
        console.log(`${green("✓")} agent ${name} removed`);
        // Best-effort: take Foreman's wiring back out of the agent's config.
        const unwired = unwireAgent(name, entry);
        for (const line of unwired.removed) console.log(`${green("✓")} removed ${line}`);
        for (const note of unwired.notes) console.log(orange("note: ") + note);
        if (!options.uninstall || !entry) {
          console.log(
            dim(
              `${label} is still installed.` +
                (installRecord && uninstallCmd
                  ? ` Foreman installed it; to uninstall it too: ${uninstallCmd}`
                  : ""),
            ),
          );
          return;
        }
        // #357 — the uninstall command follows how the binary was actually
        // installed (brew vs npm), not just the registry's hint.
        if (uninstallCmd) {
          console.log(orange(`uninstalling ${label} (${uninstallCmd})…`));
          const result = await runUninstall({
            install: entry.install,
            detection,
            onLine: (line) => console.log(`  ${dim(line)}`),
          });
          if (result.ok) {
            console.log(`${green("✓")} ${label} uninstalled`);
          } else {
            console.error(
              red("warn: ") +
                `uninstall failed (exit ${result.exitCode}). Run manually: ${result.manualCommand}`,
            );
          }
        } else if (entry.install.script) {
          console.log(
            orange("note: ") +
              `${label} was installed via a script — Foreman can't auto-uninstall. ` +
              `Remove the ${entry.install.binary ?? entry.id} binary manually (try the installer's --uninstall flag).`,
          );
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
      const identityToken = tokenStatus(agent.id);
      const publicKey = registry.getPublicKey(agent.id);
      if (options.json) {
        const payload = renderAgentJson(agent) as Record<string, unknown>;
        process.stdout.write(
          JSON.stringify(
            {
              ...payload,
              ...(publicKey ? renderPublicKeyJson(publicKey) : {}),
              identityToken,
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
      // #552 / #445 — surface the action-mediation transport so
      // operators can audit which agents go through Foreman's
      // bridge (programmable JSON-RPC), which run under wrap mode
      // (synthetic-update injection), and which fall back to the
      // legacy chat-post hybrid.
      if (registryEntry) {
        console.log(
          `  ${dim("transport:")}   ${formatTransportLine(registryEntry)}`,
        );
      }
      if (publicKey) {
        console.log(`  ${dim("key:")}         ${renderPublicKeyJson(publicKey).publicKeyFingerprint}…`);
      }
      console.log(
        `  ${dim("token:")}       ` +
          (identityToken.present
            ? `set${identityToken.updatedAt ? dim(` (issued ${new Date(identityToken.updatedAt).toISOString()})`) : ""}`
            : orange(`none — MCP calls run as untrusted:${agent.id}. Run 'foreman agent rewire ${agent.id}'.`)),
      );
      if (registryEntry) {
        const target = pickMcpConfigPath(registryEntry);
        const shown = snippetForDisplay(buildMcpSnippet(agent.id, registryEntry), target);
        console.log("");
        console.log(bold(`MCP snippet (${shown.format}${target ? `, for ${target}` : ""}):`));
        console.log(shown.text);
      }
    } catch (err) {
      handleAgentError(err);
    } finally {
      closeDb();
    }
  });

// ============================================================================
// rewire / token rotate — per-agent identity tokens on the MCP path (#618)
// ============================================================================
//
// `rewire` gives an agent a token (keeping the one it has) and writes it into
// the agent's MCP wiring; it is how installs from before #618 upgrade.
// `token rotate` mints a new one: the old token stops working at once, even
// for sessions already connected. Tokens are never printed; `--token-out`
// writes one to a 0600 file for agents wired by hand.

agentsCommand
  .command("rewire [name]")
  .description(
    "Give an agent its identity token and rewrite its MCP wiring (all agents with --all)",
  )
  .option("--all", "rewire every registered agent")
  .option("--config-path <path>", "write the wiring to this config file instead of the registry default")
  .option("--token-out <path>", "also write the token to this path (0600), for wiring by hand")
  .action(
    (
      name: string | undefined,
      options: { all?: boolean; configPath?: string; tokenOut?: string },
    ) => {
      const registry = getRegistry();
      try {
        if (Boolean(name) === Boolean(options.all)) {
          console.error(red("error: ") + "pass an agent id, or --all");
          process.exitCode = 1;
          return;
        }
        if (options.all && (options.configPath || options.tokenOut)) {
          console.error(red("error: ") + "--config-path and --token-out take a single agent, not --all");
          process.exitCode = 1;
          return;
        }
        const agents = options.all
          ? registry.listAll()
          : [registry.get(name!) ?? throwNotFound(name!)];
        if (agents.length === 0) {
          console.log("(no agents registered)");
          return;
        }
        // With --all, agents Foreman can't wire itself (custom ones) are
        // reported, not failed: they need --token-out one by one.
        let failed = 0;
        for (const agent of agents) {
          const outcome = rewireOne(agent, { rotate: false, configPath: options.configPath, tokenOut: options.tokenOut });
          if (outcome === "failed" || (outcome === "manual" && !options.all)) failed++;
        }
        process.exitCode = failed > 0 ? 1 : 0;
      } catch (err) {
        handleAgentError(err);
      } finally {
        closeDb();
      }
    },
  );

const tokenSub = agentsCommand
  .command("token")
  .description("Manage an agent's identity token (rotate)");

tokenSub
  .command("rotate <name>")
  .description("Mint a new identity token and rewrite the wiring; the old token stops working at once")
  .option("--config-path <path>", "write the wiring to this config file instead of the registry default")
  .option("--token-out <path>", "also write the new token to this path (0600), for wiring by hand")
  .option("--yes", "skip confirmation prompt")
  .action(
    async (
      name: string,
      options: { configPath?: string; tokenOut?: string; yes?: boolean },
    ) => {
      const registry = getRegistry();
      try {
        const agent = registry.get(name) ?? throwNotFound(name);
        const ok = await requireConfirm({
          yes: options.yes,
          question: `Rotate ${name}'s identity token? Running sessions drop to untrusted until the agent restarts with the new wiring.`,
          noun: `rotate the token for "${name}"`,
        });
        if (!ok) {
          console.log("(cancelled)");
          return;
        }
        const outcome = rewireOne(agent, { rotate: true, configPath: options.configPath, tokenOut: options.tokenOut });
        process.exitCode = outcome === "ok" ? 0 : 1;
      } catch (err) {
        handleAgentError(err);
      } finally {
        closeDb();
      }
    },
  );

function getTokenStore(): SecretStore {
  return new SecretStore(getDb(), loadOrCreateSecretsMasterKey());
}

function tokenStatus(agentId: string): { present: boolean; updatedAt: number | null } {
  const store = getTokenStore();
  const present = hasAgentToken(store, agentId);
  return { present, updatedAt: present ? (store.meta(agentTokenSecretName(agentId))?.updatedAt ?? null) : null };
}

function throwNotFound(agentId: string): never {
  throw new AgentNotFoundError(agentId);
}

function oldTokenInvalid(agentId: string): string {
  return (
    `The OLD token for ${agentId} is now INVALID: its MCP calls run untrusted until the new one is wired. ` +
    `Get the new one with 'foreman agent rewire ${agentId} --token-out <file>'.`
  );
}

/** Rewire (or rotate) one agent and report it. `manual` when the token has
 *  nowhere to go, so the agent would still run untrusted. */
function rewireOne(
  agent: RegisteredAgent,
  options: { rotate: boolean; configPath?: string | undefined; tokenOut?: string | undefined },
): "ok" | "manual" | "failed" {
  const registryId = typeof agent.metadata?.registryId === "string" ? agent.metadata.registryId : null;
  const entry = registryId ? safeFindAgent(loadActiveRegistry().doc, registryId) : null;
  console.log(bold(agent.id));
  // An instance (`backend --type codex`) has no wiring of its own to write:
  // Foreman gives it its identity at each launch, and writing the agent's
  // shared config would take it from the agent (agent-instance.ts).
  const instance = entry !== null && isInstance(agent.id, entry) && supportsInstances(entry) && !options.configPath;
  let result;
  let issued = false;
  try {
    result = rewireAgent(getTokenStore(), agent.id, instance ? null : entry, {
      rotate: options.rotate,
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.tokenOut ? { tokenOut: options.tokenOut } : {}),
      onTokenIssued: () => {
        issued = true;
      },
    });
  } catch (err) {
    console.log(`  ${red("✗")} ${describeWiringError(err)}`);
    // Only a token that was actually replaced makes the old one invalid.
    if (options.rotate) {
      console.log(
        `  ${orange("!")} ` +
          (issued ? oldTokenInvalid(agent.id) : `No new token was issued: ${agent.id}'s current token is unchanged.`),
      );
    }
    return "failed";
  }
  if (entry && (result.config !== "none" || result.wrapperPath)) {
    logWiring(agent.id, entry, result, (line) => console.log(`  ${line}`));
  }
  if (result.tokenOutPath) console.log(`  ${dim(`token written to ${result.tokenOutPath} (0600)`)}`);
  if (instance) {
    console.log(
      `  ${green("✓")} ${agent.id} runs as its own ${entry.name}: Foreman hands it its ${options.rotate ? "new " : ""}token at each launch` +
        dim(` (${entry.name}'s config is left as it is)`),
    );
    return "ok";
  }
  const delivered = wiringDelivered(result) || result.tokenOutPath !== null;
  if (!delivered) {
    console.log(
      `  ${orange("!")} no wiring to write for ${agent.id}` +
        (entry ? "" : " (not from the registry)") +
        `. Run 'foreman agent rewire ${agent.id} --token-out <file>' and set FOREMAN_AGENT_TOKEN in its MCP server env.`,
    );
    if (options.rotate) console.log(`  ${orange("!")} ${oldTokenInvalid(agent.id)}`);
    return "manual";
  }
  const changed =
    result.minted ||
    result.config === "written" ||
    result.config === "replaced" ||
    result.wrapperWritten ||
    result.tokenOutPath !== null;
  console.log(
    changed
      ? `  ${green("✓")} ${result.minted ? (options.rotate ? "new token issued" : "token issued") : "existing token kept"}` +
          dim(" — restart the agent (or its MCP server) to pick it up")
      : `  ${green("✓")} already wired with its token`,
  );
  return "ok";
}

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

// ============================================================================
// permissions — #518 / agent-permissions epic #517 Faz 1
// ============================================================================
//
// Merges Foreman's curated shell-tool permission allowlist into the agent's
// own settings file. Addresses the "denied + no terminal to prompt" wall
// non-interactive agents hit on common commands (git clone, gh, npm, …).
// Idempotent, preserves user-added entries, never auto-adds destructive
// commands (rm / sudo / curl / chmod / …).

agentsCommand
  .command("permissions <agentId>")
  .description(
    "Apply Foreman's default shell-tool permission allowlist for the agent " +
      "(Claude Code only for now).",
  )
  .option(
    "--dry-run",
    "Show what would change without writing to the settings file",
    false,
  )
  .action((agentId: string, opts: { dryRun: boolean }) => {
    const doc = loadActiveRegistry().doc;
    const catalogEntry = safeFindAgent(doc, agentId);
    if (!catalogEntry) {
      console.error(
        red("error: ") +
          `Unknown agent '${agentId}'. Try \`foreman agent list\`.`,
      );
      closeDb();
      process.exit(1);
    }
    if (!DEFAULT_PERMISSIONS[agentId]) {
      console.error(
        red("error: ") +
          `No permission defaults shipped for '${agentId}' yet. ` +
          `Supported: ${Object.keys(DEFAULT_PERMISSIONS).sort().join(", ")}.`,
      );
      closeDb();
      process.exit(2);
    }
    const configPaths = catalogEntry.config_paths ?? [];
    if (configPaths.length === 0) {
      console.error(
        red("error: ") +
          `Agent '${agentId}' has no config_paths in the registry — can't ` +
          `locate a settings file.`,
      );
      closeDb();
      process.exit(1);
    }
    let result;
    try {
      result = applyPermissions(
        agentId,
        resolveAgentSettingsPath(configPaths),
        { dryRun: opts.dryRun },
      );
    } catch (err) {
      console.error(
        red("error: ") +
          (err instanceof Error ? err.message : String(err)),
      );
      closeDb();
      process.exit(1);
    }
    const verb = opts.dryRun ? "Would write" : "Wrote";
    if (result.unchanged) {
      console.log(
        `${green("✓")} permissions already up to date for ${agentId}`,
      );
      console.log(`  ${dim("settings")}  ${result.settingsPath}`);
    } else {
      console.log(
        `${green("✓")} ${verb} permissions for ${bold(agentId)}` +
          (opts.dryRun ? dim(" (dry-run)") : ""),
      );
      console.log(`  ${dim("settings")}  ${result.settingsPath}`);
      console.log(
        `  ${dim("added")}     ${result.added.length} ` +
          `${result.added.length === 1 ? "entry" : "entries"}`,
      );
      // Show up to 5 added entries so the user sees what landed; long lists
      // get truncated with a count to keep the output scannable.
      const preview = result.added.slice(0, 5);
      for (const e of preview) {
        console.log(`            ${dim("+")} ${e}`);
      }
      if (result.added.length > preview.length) {
        console.log(
          `            ${dim(
            `+ ${result.added.length - preview.length} more`,
          )}`,
        );
      }
    }
    if (result.kept.length > 0) {
      console.log(
        `  ${dim("kept")}      ${result.kept.length} user-defined ` +
          `${result.kept.length === 1 ? "entry" : "entries"} (untouched)`,
      );
    }
    closeDb();
  });

// ============================================================================
// trust / untrust — #517 Faz 3
// ============================================================================
//
// Operator opts the agent out of its own shell-tool allowlist gate via
// `foreman agent trust <id>`. The spawn engine then appends the catalog's
// `task_skip_permissions_flag` (e.g. `--dangerously-skip-permissions` for
// claude-code) so the agent doesn't prompt on individual shell calls.
// Foreman's MCP-level mediation remains the security boundary.
//
// `untrust` flips it back. `show` (existing) surfaces the flag.

agentsCommand
  .command("trust <agentId>")
  .description(
    "Let the agent work on its own during tasks Foreman hands it: Codex " +
      "may write in its folder (still sandboxed), Claude Code skips its " +
      "own prompts. The role's permissions in org.yaml still apply.",
  )
  .action((agentId: string) => {
    const registry = getRegistry();
    const agent = registry.get(agentId);
    if (!agent) {
      console.error(
        red("error: ") +
          `Unknown agent '${agentId}'. Run \`foreman agent list\` for ` +
          `the installed agents.`,
      );
      closeDb();
      process.exit(1);
    }
    try {
      registry.setTaskSkipPermissions(agentId, true);
    } catch (err) {
      handleAgentError(err);
    }
    console.log(`${green("✓")} ${bold(agentId)} trusted`);
    const what = describeTaskPermissions(agentId, registry.get(agentId), true);
    if (what) console.log(`  ${dim("now")}       ${what}`);
    else
      console.log(
        `  ${dim("now")}       ${agentId} gets no extra rights from trust: Foreman has no way to change what it may do on its own`,
      );
    console.log(
      `  ${dim("revoke")}    \`foreman agent untrust ${agentId}\``,
    );
    closeDb();
  });

// ============================================================================
// hook install / hook uninstall — #517 Faz 4
// ============================================================================
//
// Wires the agent's settings file to spawn `foreman hook <agentId>` before
// every matching tool call. Once installed, a denied or risk-flagged call
// → Foreman approval pipeline → Telegram inline keyboard → user taps
// Allow / Deny → exit 0 / 2 → call proceeds or aborts. Claude Code only
// for now; Codex/OpenClaw don't expose an equivalent pre-call hook.

/** The settings file a hook command acts on: the project's with
 *  `--project [dir]`, else the agent's user settings. */
function hookSettingsPath(project: string | boolean | undefined, configPaths: string[]): string {
  if (project === undefined || project === false) return resolveAgentSettingsPath(configPaths);
  return projectSettingsPath(project === true ? process.cwd() : project);
}

const hookSub = agentsCommand
  .command("hook")
  .description(
    "Install / uninstall Foreman's PreToolUse hook in the agent's settings " +
      "(Claude Code only).",
  );

hookSub
  .command("install <agentId>")
  .description(
    "Add a PreToolUse hook to the agent's settings that pipes risky tool " +
      "calls through Foreman's approval flow (Telegram inline keyboards).",
  )
  .option(
    "--matcher <regex>",
    "Tool name regex Claude Code matches before invoking the hook",
    DEFAULT_PRETOOLUSE_MATCHER,
  )
  .option(
    "--command <cmd>",
    "Override the hook command (default: this Foreman's hook by absolute path, blocking the call if it can't run)",
  )
  .option(
    "--project [dir]",
    "Install into <dir>/.claude/settings.json (default: the current directory), so only that project is covered",
  )
  .option("--dry-run", "Show what would change without writing", false)
  .action(
    (
      agentId: string,
      opts: { matcher: string; command?: string; project?: string | boolean; dryRun: boolean },
    ) => {
      if (agentId !== "claude-code") {
        console.error(
          red("error: ") +
            `Hook install supports claude-code only. Other agents either ` +
            `don't expose a pre-call hook (Codex, OpenClaw) or are not ` +
            `supported yet.`,
        );
        closeDb();
        process.exit(2);
      }
      const catalogEntry = safeFindAgent(loadActiveRegistry().doc, agentId);
      if (!catalogEntry) {
        console.error(
          red("error: ") +
            `Unknown agent '${agentId}'. Run \`foreman agent list\`.`,
        );
        closeDb();
        process.exit(1);
      }
      const configPaths = catalogEntry.config_paths ?? [];
      if (configPaths.length === 0) {
        console.error(
          red("error: ") +
            `Agent '${agentId}' has no config_paths in the registry.`,
        );
        closeDb();
        process.exit(1);
      }
      const settingsPath = hookSettingsPath(opts.project, configPaths);
      const hookCmd =
        opts.command && opts.command.trim().length > 0
          ? opts.command
          : defaultHookCommand(agentId);
      let result;
      try {
        result = installPreToolUseHook({
          settingsPath,
          hookCommand: hookCmd,
          matcher: opts.matcher,
          dryRun: opts.dryRun,
        });
      } catch (err) {
        console.error(
          red("error: ") + (err instanceof Error ? err.message : String(err)),
        );
        closeDb();
        process.exit(1);
      }
      const verb = opts.dryRun ? "Would install" : "Installed";
      if (result.updated) {
        console.log(
          `${green("✓")} ${opts.dryRun ? "Would update" : "Updated"} the PreToolUse hook for ${bold(agentId)}` +
            (opts.dryRun ? dim(" (dry-run)") : ""),
        );
        console.log(`  ${dim("settings")}  ${result.settingsPath}`);
        console.log(`  ${dim("command")}   ${hookCmd}`);
      } else if (result.alreadyInstalled) {
        console.log(
          `${green("✓")} hook already installed for ${bold(agentId)}`,
        );
        console.log(`  ${dim("settings")}  ${result.settingsPath}`);
      } else {
        console.log(
          `${green("✓")} ${verb} PreToolUse hook for ${bold(agentId)}` +
            (opts.dryRun ? dim(" (dry-run)") : ""),
        );
        console.log(`  ${dim("settings")}  ${result.settingsPath}`);
        console.log(`  ${dim("matcher")}   ${result.matcher}`);
        console.log(`  ${dim("command")}   ${hookCmd}`);
        console.log(
          `  ${dim("revoke")}    \`foreman agent hook uninstall ${agentId}${opts.project !== undefined && opts.project !== false ? " --project" + (typeof opts.project === "string" ? ` ${opts.project}` : "") : ""}\``,
        );
      }
      closeDb();
    },
  );

hookSub
  .command("uninstall <agentId>")
  .description(
    "Remove Foreman's PreToolUse hook from the agent's settings. " +
      "User-added hook entries are left alone.",
  )
  .option(
    "--project [dir]",
    "Remove it from <dir>/.claude/settings.json (default: the current directory)",
  )
  .option("--dry-run", "Show what would change without writing", false)
  .action((agentId: string, opts: { project?: string | boolean; dryRun: boolean }) => {
    const catalogEntry = safeFindAgent(loadActiveRegistry().doc, agentId);
    if (!catalogEntry) {
      console.error(
        red("error: ") +
          `Unknown agent '${agentId}'. Run \`foreman agent list\`.`,
      );
      closeDb();
      process.exit(1);
    }
    const configPaths = catalogEntry.config_paths ?? [];
    if (configPaths.length === 0) {
      console.error(
        red("error: ") +
          `Agent '${agentId}' has no config_paths in the registry.`,
      );
      closeDb();
      process.exit(1);
    }
    const settingsPath = hookSettingsPath(opts.project, configPaths);
    let result;
    try {
      result = uninstallPreToolUseHook(settingsPath, { dryRun: opts.dryRun });
    } catch (err) {
      console.error(
        red("error: ") + (err instanceof Error ? err.message : String(err)),
      );
      closeDb();
      process.exit(1);
    }
    if (!result.removed) {
      console.log(
        `${dim("·")} no Foreman-managed PreToolUse hook found for ${bold(
          agentId,
        )} — nothing to do.`,
      );
    } else {
      console.log(
        `${green("✓")} Removed Foreman PreToolUse hook for ${bold(agentId)}` +
          (opts.dryRun ? dim(" (dry-run)") : ""),
      );
      console.log(`  ${dim("settings")}  ${result.settingsPath}`);
    }
    closeDb();
  });

agentsCommand
  .command("untrust <agentId>")
  .description(
    "Take back `foreman agent trust`: Codex reads only, Claude Code asks " +
      "unless Foreman's hook guards it.",
  )
  .action((agentId: string) => {
    const registry = getRegistry();
    const agent = registry.get(agentId);
    if (!agent) {
      console.error(
        red("error: ") +
          `Unknown agent '${agentId}'. Run \`foreman agent list\`.`,
      );
      closeDb();
      process.exit(1);
    }
    try {
      registry.setTaskSkipPermissions(agentId, false);
    } catch (err) {
      handleAgentError(err);
    }
    console.log(`${green("✓")} ${bold(agentId)} no longer trusted`);
    const what = describeTaskPermissions(agentId, registry.get(agentId), false);
    if (what) console.log(`  ${dim("now")}       ${what}`);
    closeDb();
  });

// ============================================================================
// role / responsibility / handoff — responsibility-based auto-routing
// (see docs/auto-routing-design.md).
// ============================================================================
//
// Once `role` is set on an agent (one of coder/reviewer/orchestrator/custom),
// the FlowRouter knows where to dispatch this agent's output when it
// completes a flow step. `responsibility` is free-form prose (already
// stored as responsibility_note) that surfaces in `foreman agent show`.
// `handoff` mutates the agent's handoff_rules JSON array.

const ALLOWED_ROLES = new Set([
  "coder",
  "reviewer",
  "orchestrator",
  "custom",
]);

agentsCommand
  .command("role <agentId> <role>")
  .description(
    "Set the agent's role for auto-routing. One of: coder, reviewer, " +
      "orchestrator, custom, none (unset). Affects flow handoffs only — " +
      "classic one-shot writes are unchanged.",
  )
  .action((agentId: string, role: string) => {
    const registry = getRegistry();
    const agent = registry.get(agentId);
    if (!agent) {
      console.error(red("error: ") + `Unknown agent '${agentId}'.`);
      closeDb();
      process.exit(1);
    }
    const normalized = role.toLowerCase();
    if (normalized !== "none" && !ALLOWED_ROLES.has(normalized)) {
      console.error(
        red("error: ") +
          `Invalid role '${role}'. Allowed: ${[...ALLOWED_ROLES, "none"].join(", ")}.`,
      );
      closeDb();
      process.exit(1);
    }
    try {
      registry.setRole(agentId, normalized === "none" ? null : normalized);
    } catch (err) {
      handleAgentError(err);
    }
    console.log(
      `${green("✓")} ${bold(agentId)} role = ${
        normalized === "none" ? "(unset)" : normalized
      }`,
    );
    closeDb();
  });

agentsCommand
  .command("responsibility <agentId> [text...]")
  .description(
    "Set the agent's responsibility brief (1-2 sentences describing what " +
      "this agent owns in a flow). Pass no text to clear it. Shown in " +
      "`foreman agent show` and surfaced by the orchestrator when routing.",
  )
  .action((agentId: string, text: string[]) => {
    const registry = getRegistry();
    const agent = registry.get(agentId);
    if (!agent) {
      console.error(red("error: ") + `Unknown agent '${agentId}'.`);
      closeDb();
      process.exit(1);
    }
    const joined = text.join(" ").trim();
    try {
      registry.setResponsibilityNote(agentId, joined.length > 0 ? joined : null);
    } catch (err) {
      handleAgentError(err);
    }
    console.log(
      `${green("✓")} ${bold(agentId)} responsibility = ${
        joined.length > 0 ? `"${joined}"` : "(cleared)"
      }`,
    );
    closeDb();
  });

agentsCommand
  .command("handoff <agentId> <action>")
  .description(
    "Manage the agent's handoff rules. action = 'add', 'list', 'clear'. " +
      "For 'add', also pass --when <classification> --to-role <role> " +
      "--template '<prompt>' --intent <intent>.",
  )
  .option(
    "--when <classification>",
    "Classifier verdict that triggers this rule (e.g. changes_requested, approved, code_written).",
  )
  .option(
    "--to-role <role>",
    "Role of the agent that should receive the forward (e.g. coder, reviewer).",
  )
  .option(
    "--template <prompt>",
    "Prompt template for the forwarded directive. Use {output} or {summary} placeholders.",
  )
  .option(
    "--intent <intent>",
    "Free-form intent label recorded on the new flow step (e.g. fix, review, summarize).",
  )
  .action(
    (
      agentId: string,
      action: string,
      opts: {
        when?: string;
        toRole?: string;
        template?: string;
        intent?: string;
      },
    ) => {
      const registry = getRegistry();
      const agent = registry.get(agentId);
      if (!agent) {
        console.error(red("error: ") + `Unknown agent '${agentId}'.`);
        closeDb();
        process.exit(1);
      }
      const existing = agent.handoffRules
        ? (JSON.parse(agent.handoffRules) as unknown[])
        : [];
      const rules: Array<{
        when: string;
        toRole: string;
        template: string;
        intent: string;
      }> = Array.isArray(existing)
        ? (existing.filter(
            (r) =>
              r != null &&
              typeof r === "object" &&
              "when" in r &&
              "toRole" in r &&
              "template" in r &&
              "intent" in r,
          ) as Array<{
            when: string;
            toRole: string;
            template: string;
            intent: string;
          }>)
        : [];

      if (action === "list") {
        if (rules.length === 0) {
          console.log(
            `${dim("no handoff rules — output falls through to orchestrator")}`,
          );
        } else {
          rules.forEach((r, i) => {
            console.log(
              `${bold(`${i + 1}.`)} ${dim("when")} ${r.when} ${dim("→")} ${r.toRole} ${dim("(intent:")} ${r.intent}${dim(")")}`,
            );
            console.log(`   ${dim("template:")} ${r.template}`);
          });
        }
        closeDb();
        return;
      }
      if (action === "clear") {
        registry.setHandoffRules(agentId, null);
        console.log(`${green("✓")} ${bold(agentId)} handoff rules cleared`);
        closeDb();
        return;
      }
      if (action === "add") {
        const { when, toRole, template, intent } = opts;
        if (!when || !toRole || !template || !intent) {
          console.error(
            red("error: ") +
              "add requires all of --when, --to-role, --template, --intent",
          );
          closeDb();
          process.exit(1);
        }
        rules.push({ when, toRole, template, intent });
        registry.setHandoffRules(agentId, JSON.stringify(rules));
        console.log(
          `${green("✓")} ${bold(agentId)} handoff rule added (${rules.length} total)`,
        );
        closeDb();
        return;
      }
      console.error(
        red("error: ") + `unknown action '${action}'. Use add / list / clear.`,
      );
      closeDb();
      process.exit(1);
    },
  );

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

// #552 / #445 — Render the action-mediation transport for `foreman agent
// show <id>`. Three top-level cases:
//
//   bridge    — agent declares `approval_adapter`; Foreman talks the
//               adapter's wire protocol (codex exec-server JSON-RPC,
//               ACP, …) and mediates approvals + directives over it.
//   wrap      — agent declares `input_protocol` (chat-only daemon, no
//               programmable transport). Foreman runs `foreman
//               agent-wrap` to inject synthetic user updates.
//   legacy    — neither declared; the agent goes through the
//               PreToolUse hook (claude-code) or the #433 hybrid
//               chat-post path. No structured mediation.
export function formatTransportLine(entry: AgentEntry): string {
  if (entry.approval_adapter) {
    return `bridge (${entry.approval_adapter})`;
  }
  if (entry.input_protocol) {
    return `wrap (${entry.input_protocol.schema} via ${entry.input_protocol.method})`;
  }
  return "legacy hybrid (PreToolUse hook for claude-code; chat-post fallback otherwise)";
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

  // #646 — npm would refuse the new version on a Node outside the
  // agent's engines range; say so instead of failing mid-install.
  const engineMismatch = checkNodeEngine(entry, resolveInstallerNodeVersion);
  if (engineMismatch) {
    const [first, ...rest] = describeNodeEngineMismatch(engineMismatch);
    console.error(red("error: ") + first);
    for (const line of rest) console.error(`  ${line}`);
    return 1;
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

export async function runAgentUpdateAll(
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
  if (err instanceof WiringParseError || err instanceof UnsafeTokenPathError) {
    console.error(red("error: ") + describeWiringError(err));
    process.exit(1);
  }
  if (err instanceof InvalidTokenAgentIdError) {
    console.error(red("error: ") + err.message);
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

/** What `agentId` may do on its own during a task, in one line
 *  (task-permissions.ts), or null for an agent those rules don't cover. */
function describeTaskPermissions(
  agentId: string,
  registered: Parameters<typeof catalogEntryFor>[2],
  trusted: boolean,
): string | null {
  try {
    const entry = catalogEntryFor(loadActiveRegistry().doc, agentId, registered);
    if (!entry) return null;
    let can: RoleCapability[] | undefined;
    try {
      const org = loadOrg(getForemanPaths().orgConfigPath);
      can = org ? Object.values(org.roles).find((r) => r.agent === agentId)?.can : undefined;
    } catch {
      can = ["read"];
    }
    return (
      taskPermissions({
        runtime: entry.id,
        trusted,
        hookInstalled: entry.id === "claude-code" ? claudeHookInstalled(entry.config_paths ?? []) : null,
        can,
      })?.summary ?? null
    );
  } catch {
    return null;
  }
}
