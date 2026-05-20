import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DEFAULT_FOREMAN_SOUL } from "../cli/identity-template.js";
import type { AgentEntry } from "./registry-catalog.js";

export interface ApplyForemanSoulResult {
  /** Absolute path of the agent's identity file we wrote to. */
  path: string;
  /** True when we wrote (or rewrote); false when there was nothing to do. */
  changed: boolean;
}

// Reads the canonical Foreman SOUL.md from foreman home (or returns the
// shipped default if the user hasn't seeded one yet). Pure read — never writes.
export function readForemanSoul(soulPath: string): string {
  if (!existsSync(soulPath)) return DEFAULT_FOREMAN_SOUL;
  const text = readFileSync(soulPath, "utf-8");
  return text.length === 0 ? DEFAULT_FOREMAN_SOUL : text;
}

// Writes Foreman's identity content into the agent's identity hook
// (e.g. `~/.hermes/SOUL.md`). Idempotent: skips the write when the file
// already matches the source. Returns null when the registry entry doesn't
// declare an identity_path — agents we don't have an identity hook for yet.
//
// QA round 12: every `{agent_id}` placeholder in the SOUL template is
// substituted with the entry's id so each agent reads its OWN name in
// the identity contract. Previously the template hard-coded "you are
// Foreman" which broke multi-agent orchestration — every chat host
// claimed the Foreman identity and the user couldn't tell which agent
// was responding to which message.
export function applyForemanSoul(
  entry: AgentEntry,
  soulPath: string,
  homeDir: string = homedir(),
): ApplyForemanSoulResult | null {
  if (!entry.identity_path) return null;
  const target = expandHome(entry.identity_path, homeDir);
  const template = readForemanSoul(soulPath);
  const desired = renderSoulForAgent(template, entry.id);
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : null;
  if (existing === desired) return { path: target, changed: false };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, desired, "utf-8");
  return { path: target, changed: true };
}

/**
 * Substitute the `{agent_id}` placeholder in the SOUL template with the
 * actual registered agent id. Pure helper for tests + reuse by other
 * identity-write paths (e.g. `foreman identity push`).
 */
export function renderSoulForAgent(template: string, agentId: string): string {
  return template.replace(/\{agent_id\}/g, agentId);
}

function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return resolve(homeDir, p.slice(2));
  return p;
}
