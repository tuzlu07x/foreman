import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pickConfigPath } from "../../core/agent-add-flow.js";
import {
  applyInjection,
  planInjection,
  UnsupportedConfigFormatError,
} from "../../core/agent-config-injector.js";
import { buildMcpSnippet } from "../../core/agent-mcp-snippet.js";
import {
  resolveBundledTemplatePath,
  type AgentEntry,
} from "../../core/registry-catalog.js";

/** The install step's config substep for one agent: seed its config file
 *  from the bundled template when missing (#385), then write Foreman's MCP
 *  entry into it. Best-effort: every failure is logged as a warning. */
export function wireAgentConfig(
  id: string,
  entry: AgentEntry,
  log: (line: string) => void,
): void {
  const configPath = pickConfigPath(entry);
  const requiresExisting = entry.install.requires_existing_config === true;
  if (!configPath) return;
  try {
    // #385 — Seed bundled template first when the agent's config file
    // doesn't exist (OpenClaw). Template ships under
    // registry/templates/<agent>.json; Foreman writes it expanded so
    // the MCP/secret overlay lands on a schema-valid base. Replaces
    // the #377/#378 "skip + manual repush" workaround.
    const templatePath = entry.install.config_template_path
      ? resolveBundledTemplatePath(entry.install.config_template_path)
      : null;
    let seeded = false;
    if (templatePath) {
      try {
        const raw = readFileSync(templatePath, "utf-8");
        const expanded = raw.replace(/~\//g, `${homedir()}/`);
        mkdirSync(dirname(configPath), { recursive: true });
        // "wx" (O_CREAT | O_EXCL) is the existence check: an existing
        // config (or a symlink at its path) is never overwritten or
        // written through.
        writeFileSync(configPath, expanded, { mode: 0o600, flag: "wx" });
        seeded = true;
        log(
          `  ✓ seeded ${entry.name} config from bundled template → ${configPath}`,
        );
      } catch (seedErr) {
        // EEXIST: the agent already has a config — keep it.
        if ((seedErr as NodeJS.ErrnoException).code !== "EEXIST") {
          log(
            `  ⚠ template seed failed: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`,
          );
        }
      }
    }
    // #377 fallback — when no template is bundled AND the registry
    // flags requires_existing_config, leave the file alone and hint.
    if (!seeded && requiresExisting && !existsSync(configPath)) {
      log(
        `  ⚠ ${entry.name} config not initialised at ${configPath}`,
      );
      log(
        `     Run \`${entry.install.binary ?? id}\` once to create it, then \`foreman secrets repush ${id}\` to apply Foreman's keys.`,
      );
    } else {
      const snippet = buildMcpSnippet(id, entry);
      const plan = planInjection(configPath, snippet.json);
      if (plan.alreadyHasForeman) {
        log(`  ✓ config already wired at ${configPath}`);
      } else if (plan.replacedStale) {
        applyInjection(configPath, plan);
        log(`  ⟳ replaced stale foreman entry at ${configPath}`);
      } else {
        applyInjection(configPath, plan);
        log(`  ✓ wrote MCP snippet to ${configPath}`);
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedConfigFormatError) {
      log(`  ⚠ ${configPath} unsupported format — paste manually`);
    } else {
      log(
        `  ⚠ config inject skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
