import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  AgentAlreadyRegisteredError,
  checkSecrets,
  MissingRequiredSecretsError,
  registerAgent,
} from "../core/agent-add-flow.js";
import { projectSecretsForAgent } from "../core/agent-secrets-projector.js";
import { ChatPrimaryService } from "../core/chat-primary.js";
import { applyForemanSoul } from "../core/foreman-soul.js";
import {
  detectInstall,
  disableManagedLaunchAgent,
  preferredInstallCommand,
  runInstall,
  runPostConfigCommands,
} from "../core/agent-install.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  AGENT_TOKEN_ENV,
  ensureAgentToken,
  isReservedAgentId,
} from "../core/agent-token.js";
import {
  NO_CONFIG_PATH_NOTE,
  rewireAgent,
  tokenHandoffHint,
  wiringDelivered,
  writeAgentWiring,
  type WiringResult,
} from "../core/agent-wiring.js";
import {
  checkNodeEngine,
  describeNodeEngineMismatch,
  resolveInstallerNodeVersion,
} from "../core/node-engines.js";
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
  /** Also write the agent's identity token to this file (0600), for
   *  wiring it by hand (#618). */
  tokenOut?: string;
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
  if (isReservedAgentId(agentId)) {
    logError(
      `"${agentId}" can't be an agent id: it names you (the CLI, TUI or chat) or an unverified connection.`,
    );
    return 1;
  }
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

  const detection = detectInstall(entry.install, process.env, {
    smokeTest: true,
  });
  const manualInstallCmd = preferredInstallCommand(entry.install);
  // Set only when Foreman itself ran the installer (#657).
  let installedByForeman: string | undefined;
  if (!detection.found) {
    if (detection.brokenAt) {
      log(
        orange(
          `⚠ found broken binary at ${detection.brokenAt} — will reinstall`,
        ),
      );
      if (detection.brokenReason) log(dim(`  ${detection.brokenReason}`));
    }
    // #646 — The node on PATH is outside the agent's engines range, so the
    // install would fail halfway. Explain instead; the upstream installer
    // is printed for the user to run, never run here. With --auto-install
    // stop before touching config or registration.
    const engineMismatch = checkNodeEngine(entry, resolveInstallerNodeVersion);
    if (engineMismatch) {
      const [first, ...rest] = describeNodeEngineMismatch(engineMismatch);
      if (options.autoInstall) {
        logError(first);
        for (const line of rest) log(`  ${line}`);
        return 1;
      }
      log(orange("note: ") + first);
      for (const line of rest) log(`  ${line}`);
    } else if (options.autoInstall && manualInstallCmd) {
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
      installedByForeman = manualInstallCmd;
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

  // Identity token (#618): minted here, written into the agent's MCP wiring
  // as an env var, never printed.
  if (options.skipConfig) {
    if (options.tokenOut) {
      rewireAgent(store, agentId, null, { tokenOut: options.tokenOut });
      log(dim(`agent token written to ${options.tokenOut} (0600)`));
    } else {
      log(
        orange("note: ") +
          `you're wiring ${agentId} by hand: get its token with 'foreman agent rewire ${agentId} --token-out <file>' ` +
          `and pass it as ${AGENT_TOKEN_ENV} in the MCP server's env. Without it the agent runs untrusted.`,
      );
    }
  } else {
    const token = ensureAgentToken(store, agentId);
    const wiring = writeAgentWiring(agentId, entry, token, {
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
    logWiring(agentId, entry, wiring, log);
    if (options.tokenOut) {
      rewireAgent(store, agentId, null, { tokenOut: options.tokenOut });
      log(dim(`agent token written to ${options.tokenOut} (0600)`));
    } else if (!wiringDelivered(wiring)) {
      log(`  ${tokenHandoffHint(agentId)}`);
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
        chatPrimary: new ChatPrimaryService(deps.db),
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

    // #394 — Disable any agent-managed macOS LaunchAgent so Foreman's
    // daemon manager owns the lifecycle. Best-effort, macOS-only.
    if (entry.install.macos_launch_agent_disable) {
      try {
        const r = await disableManagedLaunchAgent(
          entry.install.macos_launch_agent_disable,
        );
        if (!r.platformSkipped && r.plistRenamed) {
          log(
            green("✓") +
              ` disabled ${entry.install.macos_launch_agent_disable.label} LaunchAgent`,
          );
        }
        for (const err of r.errors) {
          log(orange("warn: ") + err);
        }
      } catch (err) {
        log(
          orange("warn: ") +
            `LaunchAgent disable failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
      installedByForeman,
    });
    handlePrivateKey(result.privateKey, options.keyOut, log);
    if (entry.identity_path) {
      try {
        // QA round 13: pass responsibility + peer agents so the multi-
        // agent SOUL.md gets the right context. Falls back gracefully
        // when no peers are registered yet (e.g. first agent install).
        const thisAgent = deps.registry.get(agentId);
        const peers = deps.registry
          .list()
          .filter((a) => a.id !== agentId)
          .map((a) => ({
            id: a.id,
            displayName: a.displayName,
            responsibilityNote: a.responsibilityNote,
          }));
        const soulResult = applyForemanSoul({
          entry,
          soulPath: getForemanPaths().soulPath,
          responsibilityNote: thisAgent?.responsibilityNote ?? null,
          peers,
        });
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
    // #445 / #552 — Surface the transport so the operator knows what
    // they just signed up for. Bridge agents auto-execute via
    // `foreman write`; legacy hybrid agents queue + relay (the
    // human is still the relay). Quiet for legacy to avoid noise on
    // every install; loud for bridge so operators know about the
    // new behavior.
    if (entry.approval_adapter === "acp-stdio-v1") {
      log(
        `  ${green("→")} ${entry.name} runs in ACP-mediated mode. ` +
          `\`foreman write ${agentId} <task>\` spawns it via \`${entry.acp_command?.command ?? agentId} acp\` ` +
          `and routes every approval through Foreman's mediator.`,
      );
    } else if (entry.approval_adapter === "codex-exec-server-v1") {
      log(
        `  ${green("→")} ${entry.name} runs through Foreman's codex exec-server bridge ` +
          `(every shell / file / network action passes risk rules first).`,
      );
    }
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

  const detection = detectInstall(entry.install, process.env, {
    smokeTest: true,
  });
  const installCmd = preferredInstallCommand(entry.install);
  let autoInstall = false;
  // #646 — Don't offer an install that can't work on this Node; the
  // scripted step below prints the requirement instead.
  const engineMismatch = detection.found
    ? null
    : checkNodeEngine(entry, resolveInstallerNodeVersion);
  if (!detection.found && installCmd && !engineMismatch) {
    if (detection.brokenAt) {
      log(
        orange(
          `⚠ found broken binary at ${detection.brokenAt} (${detection.brokenReason ?? "no diagnostic"})`,
        ),
      );
    }
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

/** Report where the agent's MCP wiring went. The snippet shown for manual
 *  pasting carries a placeholder, never the token. */
export function logWiring(
  agentId: string,
  entry: AgentEntry,
  wiring: WiringResult,
  log: (line: string) => void,
): void {
  const path = wiring.configPath;
  switch (wiring.config) {
    case "written":
      log(green("✓") + ` wrote MCP snippet with ${agentId}'s agent token to ${path}`);
      break;
    case "replaced":
      log(orange("⟳") + ` replaced stale foreman MCP entry in ${path}`);
      break;
    case "current":
      log(dim(`config: foreman entry already current at ${path}`));
      break;
    case "missing":
      log(
        orange("note: ") +
          `${entry.name} config not initialised at ${path}. Run ${entry.install.binary ?? agentId} once, then 'foreman agent rewire ${agentId}'.`,
      );
      break;
    case "unsupported":
      log(orange("note: ") + `${path} has an unsupported format. Paste this manually:`);
      log(buildMcpSnippet(agentId, entry).yaml);
      break;
    case "none":
      log(orange("note: ") + NO_CONFIG_PATH_NOTE);
      log(buildMcpSnippet(agentId, entry).yaml);
      break;
  }
  if (wiring.note) log(orange("note: ") + wiring.note);
  if (wiring.wrapperPath) {
    log(
      (wiring.wrapperWritten ? green("✓") + " wrote" : dim("✓ wrapper current:")) +
        ` ${wiring.wrapperPath}`,
    );
  }
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
