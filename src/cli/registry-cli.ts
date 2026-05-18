import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  AgentNotInRegistryError,
  findAgent,
  getRegistryCachePath,
  getUpstreamRegistryUrl,
  loadActiveRegistry,
  loadBundledRegistry,
  parseRegistryText,
  REGISTRY_CACHE_TTL_MS,
  RegistryNotFoundError,
  RegistryValidationError,
  writeRegistryCache,
  type AgentEntry,
  type RegistryDoc,
} from "../core/registry-catalog.js";
import {
  fetchAndInstallRegistry,
  getRegistryStatus,
  rollbackRegistry,
} from "../core/registry-fetch.js";
import { bold, dim, green, orange, red } from "./colors.js";

interface ListOptions {
  json?: boolean;
}

interface InfoOptions {
  json?: boolean;
}

interface UpdateOptions {
  url?: string;
  force?: boolean;
  /** #421 — Skip signature verification (NOT recommended for production). */
  insecureNoVerify?: boolean;
}

export const registryCommand = new Command("registry").description(
  "Curated agent registry (list / info / update / validate)",
);

registryCommand
  .command("list", { isDefault: true })
  .description("List agents in the curated registry")
  .option("--json", "output JSON")
  .action((options: ListOptions) => {
    const { doc, source, cachedAt } = loadActiveRegistry();
    if (options.json) {
      process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
      return;
    }
    for (const agent of doc.agents) {
      const mcp = agent.mcp_compatible ? green("mcp") : dim("legacy");
      console.log(`${orange(agent.id.padEnd(14))} ${bold(agent.name)}  ${mcp}`);
      console.log(`  ${dim(agent.tagline)}`);
    }
    console.log("");
    console.log(
      dim(
        `source: ${source}${
          cachedAt ? ` (cached ${new Date(cachedAt).toISOString()})` : ""
        }`,
      ),
    );
  });

registryCommand
  .command("info <agentId>")
  .description("Print the full registry entry for an agent")
  .option("--json", "output JSON")
  .action((agentId: string, options: InfoOptions) => {
    const { doc } = loadActiveRegistry();
    let entry: AgentEntry;
    try {
      entry = findAgent(doc, agentId);
    } catch (err) {
      if (err instanceof AgentNotInRegistryError) {
        console.error(red("error: ") + err.message);
        process.exit(1);
      }
      throw err;
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
      return;
    }
    console.log(`${bold(entry.name)}  ${dim("(" + entry.id + ")")}`);
    console.log(entry.tagline);
    console.log("");
    console.log(`${dim("homepage:        ")} ${entry.homepage}`);
    console.log(`${dim("install (npm):   ")} ${entry.install.npm ?? dim("—")}`);
    console.log(
      `${dim("install (brew):  ")} ${entry.install.brew ?? dim("—")}`,
    );
    if (entry.install.script) {
      console.log(
        `${dim("install (script):")} curl -fsSL ${entry.install.script} | bash`,
      );
    }
    console.log(
      `${dim("config paths:    ")} ${formatList(entry.config_paths)}`,
    );
    console.log(
      `${dim("required secrets:")} ${formatList(entry.required_secrets)}`,
    );
    console.log(
      `${dim("optional secrets:")} ${formatList(entry.optional_secrets)}`,
    );
    console.log(
      `${dim("mcp compatible:  ")} ${entry.mcp_compatible ? "yes" : "no"}`,
    );
    console.log(`${dim("supported:       ")} ${entry.supported_versions}`);
    console.log(`${dim("min foreman:     ")} ${entry.min_foreman_version}`);
  });

registryCommand
  .command("update")
  .description(
    "Re-fetch the registry from upstream (signed) and atomically install it. Backs up the previous cache to .bak so `foreman registry rollback` can restore it.",
  )
  .option("--url <url>", "override the upstream URL")
  .option("--force", "ignore TTL and refresh even if the cached copy is fresh")
  .option(
    "--insecure-no-verify",
    "skip signature verification — for dev / private mirrors without signing yet",
  )
  .action(async (options: UpdateOptions) => {
    const url = options.url ?? getUpstreamRegistryUrl();
    const result = await fetchAndInstallRegistry({
      url,
      allowInsecure: options.insecureNoVerify === true,
    });
    if (!result.ok) {
      console.error(red("error: ") + result.message);
      process.exit(1);
    }
    const sigNote = result.signatureVerified
      ? green(" · signature verified")
      : orange(" · ⚠ signature NOT verified (insecure mode)");
    console.log(green("✓") + ` ${result.message}${sigNote}`);
    if (result.backedUp) {
      console.log(
        `  ${dim("previous cache backed up — restore with 'foreman registry rollback'")}`,
      );
    }
    if (result.doc) {
      console.log(
        `  ${dim(`${result.doc.agents.length} agents · version ${result.doc.version}`)}`,
      );
    }
    void options.force;
  });

registryCommand
  .command("status")
  .description(
    "Show the registry source URL, cache state, public key config, and rollback availability (#421)",
  )
  .option("--json", "machine-parseable JSON output")
  .action((options: { json?: boolean }) => {
    const status = getRegistryStatus();
    if (options.json) {
      process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      return;
    }
    console.log(bold("Registry status"));
    console.log(`  ${dim("source:       ")} ${status.sourceUrl}`);
    console.log(`  ${dim("cache path:   ")} ${status.cachePath}`);
    if (status.cached) {
      const when = status.cachedAt
        ? new Date(status.cachedAt).toISOString()
        : "?";
      console.log(
        `  ${dim("cached:       ")} ${green("yes")}  (${when} · ${status.sizeBytes ?? "?"} bytes)`,
      );
      if (status.version !== null) {
        console.log(`  ${dim("schema ver:   ")} ${status.version}`);
      }
      if (status.agentCount !== null) {
        console.log(`  ${dim("agent count:  ")} ${status.agentCount}`);
      }
    } else {
      console.log(`  ${dim("cached:       ")} ${dim("no — using bundled fallback")}`);
    }
    console.log(
      `  ${dim("public key:   ")} ${status.hasPublicKey ? green(status.publicKeyPath) : orange("missing — runs require --insecure-no-verify")}`,
    );
    console.log(
      `  ${dim("rollback:     ")} ${status.hasBackup ? green("available (.bak present)") : dim("no backup yet")}`,
    );
  });

registryCommand
  .command("rollback")
  .description(
    "Restore the previous registry cache from .bak (one-deep rollback) (#421)",
  )
  .action(() => {
    const result = rollbackRegistry();
    if (!result.ok) {
      console.error(red("error: ") + result.message);
      process.exit(1);
    }
    console.log(green("✓") + ` ${result.message}`);
    console.log(
      `  ${dim("future updates will create a fresh .bak — repeated rollback is one-deep only")}`,
    );
  });

registryCommand
  .command("validate [path]")
  .description(
    "Validate a registry file against the schema (defaults to the bundled registry/agents.json)",
  )
  .action((path: string | undefined) => {
    try {
      let doc: RegistryDoc;
      if (path) {
        // Read first so ENOENT surfaces with a friendly message, separate
        // from schema/JSON errors (#270).
        let text: string;
        try {
          text = readFileSync(path, "utf-8");
        } catch (err) {
          if (
            err !== null &&
            typeof err === "object" &&
            (err as { code?: string }).code === "ENOENT"
          ) {
            console.error(red("error: ") + `file not found: ${path}`);
            process.exit(1);
          }
          throw err;
        }
        // Pass the actual path so error messages reference it instead of
        // the hardcoded "registry/agents.json" literal (#270).
        doc = parseRegistryText(text, path);
      } else {
        doc = loadBundledRegistry();
      }
      console.log(
        green("✓") +
          ` registry valid — ${doc.agents.length} agents, version ${doc.version}`,
      );
    } catch (err) {
      handleValidationError(err);
      console.error(
        red("error: ") + (err instanceof Error ? err.message : String(err)),
      );
      process.exit(1);
    }
  });

async function fetchUpstreamRegistry(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`upstream ${url} → HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function handleValidationError(err: unknown): void {
  if (err instanceof RegistryValidationError) {
    console.error(red("error: ") + err.message);
    for (const issue of err.issues) {
      console.error(`  ${dim(issue.path || "<root>")}: ${issue.message}`);
    }
    process.exit(1);
  }
  if (err instanceof RegistryNotFoundError) {
    console.error(red("error: ") + err.message);
    process.exit(1);
  }
}

function formatList(items: string[]): string {
  return items.length === 0 ? dim("—") : items.join(", ");
}
