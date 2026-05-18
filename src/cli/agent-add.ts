import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  AgentAlreadyRegisteredError,
  checkSecrets,
  MissingRequiredSecretsError,
  pickConfigPath,
  registerAgent,
} from "../core/agent-add-flow.js";
import {
  applyInjection,
  planInjection,
  UnsupportedConfigFormatError,
} from "../core/agent-config-injector.js";
import { projectSecretsForAgent } from "../core/agent-secrets-projector.js";
import { applyForemanSoul } from "../core/foreman-soul.js";
import {
  detectInstall,
  preferredInstallCommand,
  runInstall,
  runPostConfigCommands,
} from "../core/agent-install.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  AgentNotInRegistryError,
  findAgent,
  loadActiveRegistry,
  type AgentEntry,
} from "../core/registry-catalog.js";
import type { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import type { ForemanDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { readSecretValueFromStdin } from "./secrets-cli.js";
import { bold, dim, green, orange, red } from "./colors.js";

export interface AddScriptedOptions {
  type: string;
  configPath?: string;
  skipConfig?: boolean;
  /** Skip the secret projection step (#222 / #223). Power-user flag for
   *  callers that want Foreman to keep its hands off the agent's env files. */
  skipProjection?: boolean;
  /** Provider ids the user picked in the wizard — drives `if_provider` filters
   *  during projection. The scripted CLI defaults to empty (filters opt-in). */
  providersSelected?: string[];
  /** Service ids the user picked in the wizard — drives `if_service` filters. */
  servicesSelected?: string[];
  autoInstall?: boolean;
  keyOut?: string;
}

export interface AddDeps {
  db: ForemanDb;
  registry: RegistryService;
  log?: (line: string) => void;
}

export async function runAgentAddScripted(
  agentId: string,
  options: AddScriptedOptions,
  deps: AddDeps,
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { doc } = loadActiveRegistry();
  let entry: AgentEntry;
  try {
    entry = findAgent(doc, options.type);
  } catch (err) {
    if (err instanceof AgentNotInRegistryError) {
      logError(
        `unknown agent type "${options.type}". Try 'foreman registry list'.`,
      );
      return 1;
    }
    throw err;
  }

  const detection = detectInstall(entry.install);
  const manualInstallCmd = preferredInstallCommand(entry.install);
  if (!detection.found) {
    if (options.autoInstall && manualInstallCmd) {
      // --auto-install IS the user's consent — runInstall handles all three
      // transports (npm, brew, curl script) since PR #107.
      log(orange(`installing ${entry.name} (${manualInstallCmd})…`));
      const result = await runInstall({
        install: entry.install,
        onLine: (line) => log(dim(`  ${line}`)),
      });
      if (!result.ok) {
        logError(
          `install failed (exit ${result.exitCode}). Run manually: ${result.manualCommand}`,
        );
        return 1;
      }
    } else if (manualInstallCmd) {
      log(
        orange("note: ") +
          `${entry.name} is not detected on this machine. Pass --auto-install or run: ${manualInstallCmd}`,
      );
    } else {
      log(
        orange("note: ") +
          `${entry.name} is not detected on this machine — bring your own binary.`,
      );
    }
  } else {
    log(green("✓") + ` ${entry.name} detected at ${detection.path}`);
  }

  const store = new SecretStore(deps.db, loadOrCreateSecretsMasterKey());
  const secretCheck = checkSecrets(entry, store);
  if (!secretCheck.hasAllRequired) {
    const missing = secretCheck.required
      .filter((s) => !s.present)
      .map((s) => s.name);
    if (options.skipConfig) {
      // --skip-config signals "I'm wiring this up by hand" — missing secrets
      // are then the user's call. Warn but still register the agent.
      log(
        orange("warn: ") +
          `required secrets missing: ${missing.join(", ")} — add via 'foreman secrets add <name>' before 'foreman start'`,
      );
    } else {
      throw new MissingRequiredSecretsError(missing);
    }
  }

  if (!options.skipConfig) {
    const configPath = options.configPath ?? pickConfigPath(entry);
    const snippet = buildMcpSnippet(agentId, entry);
    if (configPath) {
      try {
        const plan = planInjection(configPath, snippet.json);
        if (plan.alreadyHasForeman) {
          log(dim(`config: foreman entry already current at ${configPath}`));
        } else if (plan.replacedStale) {
          applyInjection(configPath, plan);
          log(
            orange("⟳") +
              ` replaced stale foreman MCP entry in ${configPath}`,
          );
        } else {
          applyInjection(configPath, plan);
          log(green("✓") + ` wrote MCP snippet to ${configPath}`);
        }
      } catch (err) {
        if (err instanceof UnsupportedConfigFormatError) {
          log(
            orange("note: ") +
              `${configPath} has an unsupported format. Paste this manually:`,
          );
          log(snippet.yaml);
        } else {
          throw err;
        }
      }
    } else {
      log(
        orange("note: ") +
          "no config path declared in the registry — paste this into the agent's config manually:",
      );
      log(snippet.yaml);
    }
  }

  // Secret projection (#222 / #223) — write secrets into the agent's own
  // env/config files so it launches without a separate setup step. Best-effort.
  // For the scripted CLI path we project every projection the agent declares
  // (no provider/service filter — the user explicitly added this agent and
  // we don't have their wizard selection here).
  if (!options.skipProjection) {
    try {
      const projection = projectSecretsForAgent(entry, {
        providersSelected: options.providersSelected ?? [],
        servicesSelected: options.servicesSelected ?? [],
        secretStore: store,
      });
      for (const f of projection.files) {
        const tag = f.replacedStale ? "⟳" : "✓";
        log(
          `${tag} projected ${f.secrets.length} secret${f.secrets.length === 1 ? "" : "s"} → ${f.path}`,
        );
      }
      for (const s of projection.skipped) {
        log(dim(`◦ skip projection of ${s.secret}: ${s.reason}`));
      }
    } catch (err) {
      log(
        orange("warn: ") +
          `secret projection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // #398 — registry-declared post-config commands (OpenClaw's
    // `gateway install` LaunchAgent step). Runs after secrets land so
    // service installers see a valid config. Best-effort.
    const postCmds = entry.install.post_config_commands ?? [];
    if (postCmds.length > 0) {
      try {
        const results = await runPostConfigCommands(entry.install, (line) =>
          log(dim(`    ${line}`)),
        );
        for (const r of results) {
          if (r.ok) {
            log(green("✓") + ` ${r.command}`);
          } else {
            log(orange("warn: ") + `${r.command} exited ${r.exitCode}`);
          }
        }
      } catch (err) {
        log(
          orange("warn: ") +
            `post-config commands failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  try {
    const result = registerAgent({
      agentId,
      entry,
      registry: deps.registry,
    });
    handlePrivateKey(result.privateKey, options.keyOut, log);
    if (entry.identity_path) {
      try {
        const soulResult = applyForemanSoul(entry, getForemanPaths().soulPath);
        if (soulResult?.changed) {
          log(green("✓") + ` wrote Foreman identity to ${soulResult.path}`);
        } else if (soulResult) {
          log(dim(`identity: already current at ${soulResult.path}`));
        }
      } catch (err) {
        log(
          orange("warn: ") +
            `identity write skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    log(
      green("✓") +
        ` ${entry.name} is registered as "${agentId}" and ready. Run 'foreman start' to see it in action.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof AgentAlreadyRegisteredError) {
      log(
        orange("note: ") +
          `agent "${agentId}" is already registered — second 'add' is a no-op.`,
      );
      return 0;
    }
    throw err;
  }
}

export async function runAgentAddInteractive(deps: AddDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (!process.stdin.isTTY) {
    logError(
      "interactive 'foreman agent add' requires a TTY. Pass <name> --type <id> for the scripted form.",
    );
    return 1;
  }

  const { doc } = loadActiveRegistry();
  log(bold("Foreman — add an agent"));
  log("");
  doc.agents.forEach((a, i) => {
    log(`  ${orange(`[${i + 1}]`)} ${bold(a.name)}  ${dim(a.tagline)}`);
  });
  log("");
  const pick = await promptLine("Pick a number: ");
  const idx = Number.parseInt(pick.trim(), 10) - 1;
  const entry = doc.agents[idx];
  if (!entry) {
    logError("invalid selection");
    return 1;
  }

  const defaultId = entry.id;
  const idAnswer = await promptLine(`Agent id (default: ${defaultId}): `);
  const agentId = idAnswer.trim() === "" ? defaultId : idAnswer.trim();

  const detection = detectInstall(entry.install);
  const installCmd = preferredInstallCommand(entry.install);
  let autoInstall = false;
  if (!detection.found && installCmd) {
    log(
      red("✗") +
        ` ${entry.name} is not installed. ` +
        `Install it now? Foreman will run: ${installCmd}`,
    );
    const yn = await promptLine("[Y/n]: ");
    autoInstall = !/^n/i.test(yn.trim());
  } else if (detection.found) {
    log(green("✓") + ` ${entry.name} detected at ${detection.path}`);
  }

  const store = new SecretStore(deps.db, loadOrCreateSecretsMasterKey());
  for (const name of entry.required_secrets) {
    if (store.exists(name)) {
      log(green("✓") + ` using stored secret "${name}"`);
      continue;
    }
    log(orange(`Required secret "${name}" is missing.`));
    const value = await readSecretValueFromStdin(`Value for ${name}: `);
    if (value.length === 0) {
      logError(`empty value for required secret "${name}"`);
      return 1;
    }
    store.add(name, value);
    log(green("✓") + ` stored secret "${name}"`);
  }
  for (const name of entry.optional_secrets) {
    if (store.exists(name)) continue;
    const yn = await promptLine(`Optional secret "${name}" — [s]kip / [a]dd: `);
    if (/^a/i.test(yn.trim())) {
      const value = await readSecretValueFromStdin(`Value for ${name}: `);
      if (value.length > 0) {
        store.add(name, value);
        log(green("✓") + ` stored secret "${name}"`);
      }
    }
  }

  return runAgentAddScripted(
    agentId,
    {
      type: entry.id,
      autoInstall,
    },
    { ...deps, log },
  );
}

function handlePrivateKey(
  privateKey: Buffer,
  outPath: string | undefined,
  log: (line: string) => void,
): void {
  if (outPath) {
    writeFileSync(outPath, privateKey, { mode: 0o600 });
    log(dim(`private key written to ${outPath}`));
    return;
  }
  log("");
  log(orange("agent private key (printed once, store it now):"));
  log(privateKey.toString("hex"));
}

function promptLine(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer);
    });
  });
}

function logError(message: string): void {
  console.error(red("error: ") + message);
}
