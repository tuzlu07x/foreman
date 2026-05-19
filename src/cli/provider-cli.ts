import { existsSync } from "node:fs";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import {
  deriveDefaultModelId,
  describeResolveError,
  resolveAgentProviderConfig,
} from "../core/provider-resolver.js";
import {
  findAgent,
  loadActiveRegistry,
  AgentNotInRegistryError,
  type AgentEntry,
} from "../core/registry-catalog.js";
import { AgentNotFoundError, RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { bold, dim, green, orange, red } from "./colors.js";

// =============================================================================
// `foreman provider list/switch` (#408 / #412 — Phase 4)
// =============================================================================
//
// Operator-facing CLI for inspecting + switching the active provider variant
// per registered agent. `list` is read-only and machine-parseable (--json);
// `switch` writes the agent's active variant to SQLite + re-applies config
// via the existing projector. Both consult the registry's `provider_mapping`
// declarations (Phase 1) via the resolver (Phase 2).

function bootCli(): {
  registry: RegistryService;
  registryDoc: ReturnType<typeof loadActiveRegistry>;
  secretStore: SecretStore;
} {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") + `Foreman is not initialised. Run 'foreman init' first.`,
    );
    process.exit(1);
  }
  const db = getDb();
  const registry = new RegistryService(db, bus);
  const registryDoc = loadActiveRegistry();
  const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
  return { registry, registryDoc, secretStore };
}

function findCatalogAgent(
  doc: ReturnType<typeof loadActiveRegistry>,
  agentId: string,
): AgentEntry {
  try {
    return findAgent(doc.doc, agentId);
  } catch (err) {
    if (err instanceof AgentNotInRegistryError) {
      console.error(
        red("error: ") +
          `agent "${agentId}" not in registry. Run 'foreman registry validate' to list known agents.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

// =============================================================================
// list
// =============================================================================

interface VariantStatusRow {
  agentId: string;
  foremanProvider: string;
  variantId: string;
  label: string;
  active: boolean;
  requiredSecret: string | null;
  secretStatus: "present" | "missing" | "n/a";
  interactiveSetup: string | null;
  /** #461 — Mandatory dependency on another agent's OAuth (e.g. Hermes
   *  via-codex-oauth → `codex login`). Surfaced alongside the variant
   *  label so users see the real prerequisite, not "no secret required". */
  dependsOnOauthCommand: string | null;
}

function buildListRows(
  agentId: string,
  entry: AgentEntry,
  registry: RegistryService,
  secretStore: SecretStore,
): VariantStatusRow[] {
  const registered = registry.get(agentId);
  const activeProvider = registered?.llmProvider ?? null;
  const activeVariant = registered?.providerVariant ?? null;
  const mapping = entry.provider_mapping ?? {};
  const rows: VariantStatusRow[] = [];
  for (const [providerId, providerEntry] of Object.entries(mapping)) {
    const preferred = providerEntry.preferred;
    for (const [variantId, variant] of Object.entries(providerEntry.variants)) {
      const isActive =
        providerId === activeProvider &&
        (activeVariant === variantId ||
          (activeVariant === null && variantId === preferred));
      const reqSecret = variant.required_secret ?? null;
      let secretStatus: "present" | "missing" | "n/a" = "n/a";
      if (reqSecret) {
        secretStatus = secretStore.exists(reqSecret) ? "present" : "missing";
      }
      rows.push({
        agentId,
        foremanProvider: providerId,
        variantId,
        label: variant.label,
        active: isActive,
        requiredSecret: reqSecret,
        secretStatus,
        interactiveSetup: variant.interactive_setup ?? null,
        dependsOnOauthCommand: variant.depends_on_oauth?.setup_command ?? null,
      });
    }
  }
  return rows;
}

function renderListText(rows: VariantStatusRow[], agentName: string): string {
  if (rows.length === 0) {
    return `${dim("(no provider_mapping declared)")}\n`;
  }
  const byProvider = new Map<string, VariantStatusRow[]>();
  for (const r of rows) {
    const list = byProvider.get(r.foremanProvider) ?? [];
    list.push(r);
    byProvider.set(r.foremanProvider, list);
  }
  let out = bold(`${agentName} — provider mapping`) + "\n\n";
  for (const [provider, list] of byProvider.entries()) {
    out += `  ${bold(provider + ":")}\n`;
    for (const row of list) {
      const tag = row.active ? green("(active) ") : "         ";
      const secret = row.requiredSecret
        ? `needs ${row.requiredSecret} ${
            row.secretStatus === "present"
              ? green("✓ present")
              : orange("✗ missing")
          }`
        : row.dependsOnOauthCommand
          ? `needs \`${row.dependsOnOauthCommand}\` ${dim("(external oauth)")}`
          : row.interactiveSetup
            ? `needs \`${row.interactiveSetup}\` ${dim("(oauth)")}`
            : dim("no secret required");
      out += `    ${tag}${row.variantId.padEnd(20)} ${secret}\n`;
    }
    out += "\n";
  }
  return out;
}

const providerListCommand = new Command("list")
  .description("List provider variants for an agent + which secrets each needs")
  .argument("<agent>", "agent id (e.g. hermes)")
  .option("--json", "machine-parseable JSON output")
  .action((agentId: string, options: { json?: boolean }) => {
    const { registry, registryDoc, secretStore } = bootCli();
    const entry = findCatalogAgent(registryDoc, agentId);
    const rows = buildListRows(agentId, entry, registry, secretStore);
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ agentId, variants: rows }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(renderListText(rows, entry.name));
    }
    closeDb();
  });

// =============================================================================
// switch
// =============================================================================

interface SwitchOptions {
  variant?: string;
  yes?: boolean;
}

async function applySwitch(
  agentId: string,
  foremanProvider: string,
  options: SwitchOptions,
): Promise<number> {
  const { registry, registryDoc, secretStore } = bootCli();
  const entry = findCatalogAgent(registryDoc, agentId);
  const registered = registry.get(agentId);
  if (!registered) {
    console.error(
      red("error: ") +
        `agent "${agentId}" is not registered with Foreman. Run 'foreman agent add ${agentId}' first.`,
    );
    closeDb();
    return 1;
  }
  // Validate via the resolver — confirms provider + variant exist, secret
  // present. This is the same path the projector uses, so success here
  // means a downstream re-projection will succeed too.
  const lookup = (name: string): string | null =>
    secretStore.exists(name) ? secretStore.get(name) : null;
  const resolved = resolveAgentProviderConfig({
    agent: entry,
    foremanProvider,
    modelId: defaultModelFor(foremanProvider),
    variantOverride: options.variant,
    secretLookup: lookup,
  });
  if (!resolved.ok) {
    console.error(red("✗ ") + describeResolveError(resolved.error));
    if (resolved.error.kind === "missing_secret") {
      const acq = resolved.error.acquisition;
      if (acq?.url) {
        process.stderr.write(
          dim(`  Get one: ${acq.url}\n`) +
            dim(`  Add it:  foreman secrets add ${resolved.error.secretName}\n`),
        );
      } else {
        process.stderr.write(
          dim(`  Add it:  foreman secrets add ${resolved.error.secretName}\n`),
        );
      }
    }
    closeDb();
    return 1;
  }
  // Confirm interactive (unless --yes) — switching changes the agent's
  // active config on disk. User should know.
  if (!options.yes && !process.stdin.isTTY) {
    console.error(
      red("error: ") +
        `non-TTY without --yes — refusing to switch implicitly. Re-run with --yes if you're confident.`,
    );
    closeDb();
    return 1;
  }
  // Persist the new variant. Re-projection of config files happens
  // out-of-band at next `foreman start` (or via `foreman secrets repush`
  // — Phase 5 will automate this).
  registry.setLlmProvider(agentId, foremanProvider);
  registry.setProviderVariant(agentId, resolved.config.variantId);
  process.stdout.write(
    green("✓ ") +
      `${entry.name} now uses ${foremanProvider}/${resolved.config.variantId}\n` +
      dim(
        `  Restart the agent (or re-run 'foreman start') for config files to be rewritten with the new variant.\n`,
      ),
  );
  closeDb();
  return 0;
}

const providerSwitchCommand = new Command("switch")
  .description("Switch an agent to a different provider / variant")
  .argument("<agent>", "agent id (e.g. hermes)")
  .argument("<provider>", "foreman-level provider id (openai / anthropic / gemini / ...)")
  .option("--variant <id>", "specific variant within the provider (defaults to preferred)")
  .option("--yes", "skip the interactive confirm prompt")
  .action(async (agentId: string, provider: string, options: SwitchOptions) => {
    const exit = await applySwitch(agentId, provider, options);
    process.exit(exit);
  });

// #434 — Pin a specific model version for an agent. The projector
// substitutes this into `${model}` tokens in the variant's writes;
// when omitted, the registry's variant default applies.
const providerModelCommand = new Command("model")
  .description(
    "Pin a specific model version for an agent (e.g. claude-opus-4-7). Pass --clear to revert to the variant default.",
  )
  .argument("<agent>", "agent id (e.g. hermes)")
  .argument("[model]", "model id (e.g. claude-opus-4-7, gpt-4o-mini). Omit when using --clear.")
  .option("--clear", "remove any pinned model; the projector will use the variant default")
  .action(
    (agentId: string, model: string | undefined, options: { clear?: boolean }) => {
      const exit = applyModelPin(agentId, model, options);
      process.exit(exit);
    },
  );

export function applyModelPin(
  agentId: string,
  model: string | undefined,
  options: { clear?: boolean },
): 0 | 1 | 2 {
  if (!options.clear && (!model || model.trim().length === 0)) {
    console.error(
      red("error: ") +
        "specify a model id or pass --clear to remove the pin",
    );
    return 2;
  }
  const db = getDb();
  try {
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    const agent = registry.get(agentId);
    if (!agent) {
      console.error(red("error: ") + `agent "${agentId}" not registered`);
      return 1;
    }
    const next = options.clear ? null : (model ?? "").trim();
    registry.setModelVersion(agentId, next);
    if (options.clear) {
      console.log(
        `${green("✓")} cleared model pin for ${agentId} — projector will use the variant default`,
      );
    } else {
      console.log(`${green("✓")} pinned ${agentId} to ${next}`);
      console.log(
        dim(
          `  Re-run \`foreman start\` (or \`foreman secrets repush ${agentId}\`) to apply.`,
        ),
      );
    }
    return 0;
  } finally {
    closeDb();
  }
}

// =============================================================================
// Helpers
// =============================================================================

function defaultModelFor(foremanProvider: string): string {
  // #419 — Single-source data lookup via the resolver's data-driven
  // helper (registry/providers.json default_model field).
  return deriveDefaultModelId(foremanProvider);
}

// =============================================================================
// Public command
// =============================================================================

export const providerCommand = new Command("provider")
  .description(
    "Inspect or change an agent's provider variant (per-agent provider mapping)",
  )
  .addCommand(providerListCommand)
  .addCommand(providerSwitchCommand)
  .addCommand(providerModelCommand);

// Re-export for tests
export {
  AgentNotFoundError,
  buildListRows,
  renderListText,
  applySwitch,
};

// EventBus import only used inside the pinModel handler — kept inline
// to avoid the unused-import warning when the new command is tree-shaken.
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
