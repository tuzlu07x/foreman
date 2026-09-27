import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pickConfigPath } from "../../core/agent-add-flow.js";
import { UnsupportedConfigFormatError } from "../../core/agent-config-injector.js";
import { ensureAgentToken } from "../../core/agent-token.js";
import { describeWiringError, writeAgentWiring } from "../../core/agent-wiring.js";
import {
  resolveBundledTemplatePath,
  type AgentEntry,
} from "../../core/registry-catalog.js";
import type { SecretStore } from "../../core/secret-store.js";

/** The install step's config substep for one agent: seed its config file
 *  from the bundled template when missing (#385), then write Foreman's MCP
 *  entry into it. Best-effort: every failure is logged as a warning. */
export function wireAgentConfig(
  id: string,
  entry: AgentEntry,
  secretStore: SecretStore,
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
        `     Run \`${entry.install.binary ?? id}\` once to create it, then \`foreman secrets repush ${id}\` and \`foreman agent rewire ${id}\` to apply Foreman's keys and MCP wiring.`,
      );
    } else {
      // #618 — the wiring carries the agent's identity token, and goes
      // where the agent reads MCP servers (Claude Code: ~/.claude.json).
      const wiring = writeAgentWiring(id, entry, ensureAgentToken(secretStore, id));
      const mcpPath = wiring.configPath ?? configPath;
      if (wiring.config === "current") {
        log(`  ✓ config already wired at ${mcpPath}`);
      } else if (wiring.config === "replaced") {
        log(`  ⟳ replaced stale foreman entry at ${mcpPath}`);
      } else if (wiring.config === "written") {
        log(`  ✓ wrote MCP snippet to ${mcpPath}`);
      } else if (wiring.config === "unsupported") {
        log(`  ⚠ ${mcpPath} unsupported format — paste manually`);
      } else if (wiring.config === "missing") {
        log(`  ⚠ ${mcpPath} not found — run the agent once, then \`foreman agent rewire ${id}\``);
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedConfigFormatError) {
      log(`  ⚠ ${configPath} unsupported format — paste manually`);
    } else {
      // Never a raw parser message: it may quote a token-bearing file.
      log(`  ⚠ config inject skipped: ${describeWiringError(err)}`);
    }
  }
}
