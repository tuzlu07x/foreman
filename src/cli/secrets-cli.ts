import { existsSync } from "node:fs";
import { Command } from "commander";
import {
  projectSecretsForAgent,
  type WrittenFile,
} from "../core/agent-secrets-projector.js";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { loadActiveRegistry } from "../core/registry-catalog.js";
import { RegistryService } from "../core/registry.js";
import {
  SecretAlreadyExistsError,
  SecretNotFoundError,
  SecretStore,
} from "../core/secret-store.js";
import { closeDb, getDb, type ForemanDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, orange, red } from "./colors.js";
import { requireConfirm } from "./require-confirm.js";

interface AddOptions {
  value?: string;
}

interface ShowOptions {
  reveal?: boolean;
  yesIWantToSeeIt?: boolean;
  json?: boolean;
}

interface ListOptions {
  json?: boolean;
}

interface RemoveOptions {
  yes?: boolean;
}

interface RotateOptions {
  value?: string;
}

function getStore(): SecretStore {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") + `Foreman is not initialised. Run 'foreman init' first.`,
    );
    process.exit(1);
  }
  return new SecretStore(getDb(), loadOrCreateSecretsMasterKey());
}

export async function readSecretValueFromStdin(
  prompt: string,
): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    process.stderr.write(prompt);
    return readSilent();
  }
  return readAllStdin();
}

function readSilent(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    stdin.setEncoding("utf8");
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          finish();
          return;
        }
        if (code === 3) {
          stdin.setRawMode?.(false);
          stdin.removeListener("data", onData);
          stdin.pause();
          reject(new Error("aborted"));
          return;
        }
        if (code === 127 || code === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const finish = (): void => {
      stdin.setRawMode?.(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      process.stderr.write("\n");
      resolve(value);
    };
    stdin.on("data", onData);
  });
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string | Buffer) => {
      chunks.push(typeof c === "string" ? c : c.toString("utf8"));
    });
    process.stdin.on("end", () => resolve(chunks.join("").replace(/\n$/, "")));
  });
}


export const secretsCommand = new Command("secrets").description(
  "Encrypted secret store (add / list / show / remove / rotate)",
);

secretsCommand
  .command("add <name>")
  .description("Store a new secret (prompts for value)")
  .option("--value <value>", "supply value via flag instead of prompting")
  .action(async (name: string, options: AddOptions) => {
    const store = getStore();
    try {
      const value =
        options.value ?? (await readSecretValueFromStdin(`Value for ${name}: `));
      if (value.length === 0) {
        console.error(red("error: ") + "empty secret value");
        process.exit(1);
      }
      store.add(name, value);
      console.log(green("✓") + ` stored secret "${name}"`);
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

secretsCommand
  .command("list", { isDefault: true })
  .description("List secret names (never values)")
  .option("--json", "output JSON")
  .action((options: ListOptions) => {
    const store = getStore();
    const rows = store.list();
    if (options.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else if (rows.length === 0) {
      console.log("(no secrets stored)");
    } else {
      for (const r of rows) {
        const last = r.lastAccessedAt
          ? new Date(r.lastAccessedAt).toISOString()
          : "never";
        console.log(`${r.name}  ${dim(`last accessed: ${last}`)}`);
      }
    }
    closeDb();
  });

secretsCommand
  .command("show <name>")
  .description("Print a secret value (requires --reveal)")
  .option(
    "-r, --reveal",
    "confirm you really want to print the value to your terminal",
  )
  .option(
    "--yes-i-want-to-see-it",
    "deprecated alias for --reveal (kept for back-compat)",
  )
  .option("--json", "output JSON")
  .action((name: string, options: ShowOptions) => {
    const store = getStore();
    if (!options.reveal && !options.yesIWantToSeeIt) {
      console.error(
        red("error: ") +
          "refusing to print without --reveal (guards typo'd commands)",
      );
      closeDb();
      process.exit(1);
    }
    try {
      const value = store.get(name);
      if (options.json) {
        process.stdout.write(JSON.stringify({ name, value }, null, 2) + "\n");
      } else {
        process.stdout.write(value + "\n");
      }
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

secretsCommand
  .command("remove <name>")
  .description("Remove a secret")
  .option("--yes", "skip confirmation prompt")
  .action(async (name: string, options: RemoveOptions) => {
    const store = getStore();
    try {
      // Validate existence BEFORE the confirmation prompt. Two reasons (#260):
      // 1. A "doesn't exist" error path that only fires AFTER a user confirms
      //    a phantom removal is bad UX.
      // 2. In non-TTY contexts the prompt auto-cancels (see below), so
      //    `remove never-existed` would print "(cancelled)" instead of the
      //    real "no secret named" error and exit 0, masking the failure.
      if (!store.exists(name)) {
        throw new SecretNotFoundError(name);
      }
      const ok = await requireConfirm({
        yes: options.yes,
        question: `Remove secret "${name}"?`,
        noun: `remove "${name}"`,
      });
      if (!ok) {
        console.log("(cancelled)");
        return;
      }
      store.remove(name);
      console.log(green("✓") + ` removed secret "${name}"`);
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

secretsCommand
  .command("rotate <name>")
  .description("Replace the value of an existing secret")
  .option("--value <value>", "supply value via flag instead of prompting")
  .action(async (name: string, options: RotateOptions) => {
    const store = getStore();
    try {
      const value =
        options.value ??
        (await readSecretValueFromStdin(`New value for ${name}: `));
      if (value.length === 0) {
        console.error(red("error: ") + "empty secret value");
        process.exit(1);
      }
      store.rotate(name, value);
      console.log(green("✓") + ` rotated secret "${name}"`);
      // Fanout: re-project this secret into every registered agent's config
      // file that references it (#222 / #223). Best-effort — a missing config
      // path or a write error is logged but doesn't fail the rotate.
      try {
        const fanout = fanoutRotation(name, store, getDb());
        for (const f of fanout) {
          console.log(
            green("  ↳") +
              ` re-projected to ${f.agentId} (${f.path}${f.replacedStale ? " — replaced stale" : ""})`,
          );
        }
      } catch (err) {
        console.log(
          orange("  warn: ") +
            `projection fanout failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

interface FanoutFile {
  agentId: string;
  path: string;
  replacedStale: boolean;
}

/**
 * Re-project a rotated secret into every **installed** agent that references
 * it. "Installed" = present in the user's registry DB (added via
 * `foreman agent add` or `foreman setup`), NOT the bundled catalog. Without
 * this filter we'd happily create `~/.hermes/.env` etc. for agents the user
 * has never installed (issue #258).
 *
 * Returns one row per file we touched so the CLI can log what changed.
 * Best-effort: any single agent that fails is dropped from the result with
 * no exception (callers don't want a rotate to abort because one config
 * file is malformed).
 */
function fanoutRotation(
  secretName: string,
  store: SecretStore,
  db: ForemanDb,
): FanoutFile[] {
  const { doc } = loadActiveRegistry();
  const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
  const installed = registry.listAll();
  // Map: catalog entry id → true if the user has at least one agent backed
  // by that catalog entry. metadata.registryId is set by `registerAgent`.
  const installedCatalogIds = new Set<string>();
  for (const a of installed) {
    const ref = a.metadata?.registryId;
    if (typeof ref === "string") installedCatalogIds.add(ref);
  }
  const touched: FanoutFile[] = [];
  for (const entry of doc.agents) {
    if (!entry.secret_projection) continue;
    if (!installedCatalogIds.has(entry.id)) continue;
    if (!referencesSecret(entry.secret_projection, secretName)) continue;
    // We have no provider/service context here, so pass empty filter arrays —
    // every if_provider / if_service condition will fail-closed and only
    // unconditional projection writes will fire. To force the rotated secret
    // through anyway, project unfiltered: pass the secret's own match
    // criteria as the selection sets.
    const opts = {
      providersSelected: extractProviderHints(entry.secret_projection, secretName),
      servicesSelected: extractServiceHints(entry.secret_projection, secretName),
      secretStore: store,
    };
    let projection: ReturnType<typeof projectSecretsForAgent>;
    try {
      projection = projectSecretsForAgent(entry, opts);
    } catch {
      continue;
    }
    for (const f of projection.files) {
      if (f.secrets.includes(secretName)) {
        touched.push({
          agentId: entry.id,
          path: f.path,
          replacedStale: f.replacedStale,
        });
      }
    }
  }
  return touched;
}

function referencesSecret(
  projection: NonNullable<
    ReturnType<typeof loadActiveRegistry>['doc']['agents'][number]['secret_projection']
  >,
  secretName: string,
): boolean {
  if (projection.env_vars) {
    for (const spec of Object.values(projection.env_vars)) {
      if (spec.from_secret === secretName) return true;
    }
  }
  if (projection.json_channels) {
    for (const ch of Object.values(projection.json_channels.channels)) {
      if (ch.from_secret === secretName) return true;
    }
  }
  if (projection.toml_writes) {
    for (const w of projection.toml_writes) {
      if (typeof w.value !== 'string' && w.value.from_secret === secretName) return true;
    }
  }
  if (projection.auth_json && projection.auth_json.from_secret === secretName) return true;
  return false;
}

function extractProviderHints(
  projection: NonNullable<
    ReturnType<typeof loadActiveRegistry>['doc']['agents'][number]['secret_projection']
  >,
  secretName: string,
): string[] {
  const hints = new Set<string>();
  if (projection.env_vars) {
    for (const spec of Object.values(projection.env_vars)) {
      if (spec.from_secret === secretName && spec.if_provider) hints.add(spec.if_provider);
    }
  }
  if (projection.auth_json?.from_secret === secretName && projection.auth_json.if_provider) {
    hints.add(projection.auth_json.if_provider);
  }
  return [...hints];
}

function extractServiceHints(
  projection: NonNullable<
    ReturnType<typeof loadActiveRegistry>['doc']['agents'][number]['secret_projection']
  >,
  secretName: string,
): string[] {
  const hints = new Set<string>();
  if (projection.env_vars) {
    for (const spec of Object.values(projection.env_vars)) {
      if (spec.from_secret === secretName && spec.if_service) hints.add(spec.if_service);
    }
  }
  if (projection.json_channels) {
    for (const ch of Object.values(projection.json_channels.channels)) {
      if (ch.from_secret === secretName && ch.if_service) hints.add(ch.if_service);
    }
  }
  return [...hints];
}

function handleStoreError(err: unknown): void {
  if (err instanceof SecretNotFoundError) {
    console.error(red("error: ") + `no secret named "${err.secretName}"`);
    process.exit(1);
  }
  if (err instanceof SecretAlreadyExistsError) {
    console.error(
      red("error: ") +
        `secret "${err.secretName}" already exists — use 'foreman secrets rotate' to replace it`,
    );
    process.exit(1);
  }
  throw err;
}
