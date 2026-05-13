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
  .description("Re-fetch the registry from upstream and cache for 24 h")
  .option("--url <url>", "override the upstream URL")
  .option("--force", "ignore TTL and refresh even if the cached copy is fresh")
  .action(async (options: UpdateOptions) => {
    const url = options.url ?? getUpstreamRegistryUrl();
    try {
      const text = await fetchUpstreamRegistry(url);
      const doc = parseRegistryText(text);
      writeRegistryCache(doc);
      console.log(green("✓") + ` registry refreshed from ${url}`);
      console.log(`  ${dim(`cached at ${getRegistryCachePath()}`)}`);
      console.log(
        `  ${dim(`TTL: ${Math.round(REGISTRY_CACHE_TTL_MS / 3600_000)} h`)}`,
      );
      void options.force;
    } catch (err) {
      handleValidationError(err);
      console.error(
        red("error: ") +
          `failed to refresh registry: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
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
        doc = parseRegistryText(readFileSync(path, "utf-8"));
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
