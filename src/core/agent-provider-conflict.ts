import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentEntry } from "./registry-catalog.js";

// =============================================================================
// Agent provider-conflict detector (#350)
// =============================================================================
//
// QA round 3: Foreman projects OPENAI_API_KEY into ~/.hermes/.env, but
// Hermes still talks to OpenRouter because the user's pre-existing
// ~/.hermes/config.yaml has `provider: openrouter` baked in from a
// previous Hermes setup. Hermes' priority is config.yaml > env vars, so
// Foreman's injection silently has no effect and every request fails 401.
//
// This module is the "Option A" warning path (least invasive — see
// docs/runbook/qa-round-3.md). After projection, the wizard parses the
// agent's config and compares the provider value with what Foreman wired.
// Mismatch → log a warning with the manual fix command. We don't edit the
// config in place (Option B is v0.2 territory) — we just stop the user
// from being silently locked into the wrong provider.

export interface ProviderConflict {
  agentId: string;
  configPath: string;
  configProvider: string;
  foremanProvider: string;
  /** From `secret_projection.provider_check.fix_command`. */
  fixCommand: string | null;
}

export interface DetectOptions {
  /** Override $HOME for tests. */
  home?: string;
}

/**
 * Returns a conflict descriptor when the agent's config names a different
 * provider than the one Foreman wired up, or null when:
 *   - the agent has no `provider_check` block (most agents),
 *   - the config file doesn't exist (fresh install — nothing to conflict with),
 *   - parsing fails (can't make a confident claim),
 *   - the config provider field is missing,
 *   - the values match.
 */
export function detectProviderConflict(
  entry: AgentEntry,
  foremanProvider: string,
  options: DetectOptions = {},
): ProviderConflict | null {
  const check = entry.secret_projection?.provider_check;
  if (!check) return null;
  const home = options.home ?? homedir();
  const expanded = expandHome(check.path, home);
  if (!existsSync(expanded)) return null;
  let raw: string;
  try {
    raw = readFileSync(expanded, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = check.format === "yaml" ? parseYaml(raw) : JSON.parse(raw);
  } catch {
    return null;
  }
  const value = readDotPath(parsed, check.key);
  if (typeof value !== "string" || value.length === 0) return null;
  if (value === foremanProvider) return null;
  return {
    agentId: entry.id,
    configPath: expanded,
    configProvider: value,
    foremanProvider,
    fixCommand: check.fix_command ?? null,
  };
}

/**
 * Format a conflict as human-readable lines for the install log. Returned
 * lines have no leading indent — caller decides the prefix.
 */
export function formatConflictWarning(conflict: ProviderConflict): string[] {
  const lines = [
    `${conflict.configPath} has provider: ${conflict.configProvider} — Foreman wired up ${conflict.foremanProvider} but the agent's own config takes priority.`,
  ];
  if (conflict.fixCommand) {
    lines.push(`Run \`${conflict.fixCommand}\` to switch the agent to ${conflict.foremanProvider}.`);
  } else {
    lines.push(`Edit ${conflict.configPath} and set provider: ${conflict.foremanProvider}.`);
  }
  return lines;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return path;
}

function readDotPath(obj: unknown, dotPath: string): unknown {
  const segments = dotPath.split(".");
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}
