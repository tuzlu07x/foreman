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
import { detectInstall, runInstall } from "../core/agent-install.js";
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
import { readSecretValueFromStdin } from "./secrets-cli.js";
import { bold, dim, green, orange, red } from "./colors.js";

export interface AddScriptedOptions {
  type: string;
  configPath?: string;
  skipConfig?: boolean;
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
  if (!detection.found) {
    if (options.autoInstall && (entry.install.npm || entry.install.brew)) {
      log(orange(`installing ${entry.install.npm ?? entry.install.brew}…`));
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
    } else if (entry.install.npm || entry.install.brew) {
      log(
        orange("note: ") +
          `${entry.name} is not detected on this machine. Pass --auto-install or run: ${
            entry.install.npm
              ? `npm install -g ${entry.install.npm}`
              : `brew install ${entry.install.brew}`
          }`,
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
    throw new MissingRequiredSecretsError(missing);
  }

  if (!options.skipConfig) {
    const configPath = options.configPath ?? pickConfigPath(entry);
    const snippet = buildMcpSnippet(agentId, entry);
    if (configPath) {
      try {
        const plan = planInjection(configPath, snippet.json);
        if (plan.alreadyHasForeman) {
          log(dim(`config: foreman entry already present at ${configPath}`));
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

  try {
    const result = registerAgent({
      agentId,
      entry,
      registry: deps.registry,
    });
    handlePrivateKey(result.privateKey, options.keyOut, log);
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
  let autoInstall = false;
  if (!detection.found && (entry.install.npm || entry.install.brew)) {
    log(
      red("✗") +
        ` ${entry.name} is not installed. ` +
        `Install it now? Foreman will run: ${
          entry.install.npm
            ? `npm install -g ${entry.install.npm}`
            : `brew install ${entry.install.brew}`
        }`,
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
