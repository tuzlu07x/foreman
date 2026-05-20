import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DEFAULT_FOREMAN_SOUL } from "../cli/identity-template.js";
import type { AgentEntry } from "./registry-catalog.js";

/**
 * Peer agent context that the SOUL.md needs to render per agent — i.e.
 * everyone OTHER than the agent being written to, plus their declared
 * responsibility. Generic for any N-agent install: callers usually
 * pass `registry.list()` filtered to !== currentAgentId.
 */
export interface PeerAgent {
  id: string;
  displayName?: string | undefined;
  responsibilityNote?: string | null | undefined;
}

export interface ApplyForemanSoulInput {
  /** Catalog entry for the agent we're writing identity into. */
  entry: AgentEntry;
  /** Path to Foreman's canonical SOUL.md template on disk. */
  soulPath: string;
  /** Responsibility note registered for THIS agent (from registry.responsibilityNote).
   *  null when the user didn't set one — falls back to a generic phrasing. */
  responsibilityNote?: string | null | undefined;
  /** Other registered agents the wizard / CLI knows about, so each agent
   *  can name + role-tag its peers and route directives through Foreman.
   *  Empty when this is the only agent — peer block degrades gracefully. */
  peers?: PeerAgent[];
  /** Optional override of $HOME for tests. */
  homeDir?: string;
}

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
// QA round 12 added `{agent_id}` substitution so each agent reads its OWN
// name. Multi-agent generalization (QA round 13): the template ALSO
// substitutes `{responsibility}` (this agent's role from registry) and
// `{peer_agents_block}` (a rendered table of OTHER registered agents +
// their responsibilities, so each agent knows who to coordinate with).
//
// Two overloads:
//   - applyForemanSoul(entry, soulPath, homeDir?)  ← legacy, no peer
//     context. Used by callers that don't have registry state yet
//     (initial seed). Renders with empty peer block + generic
//     responsibility phrasing.
//   - applyForemanSoul({ entry, soulPath, responsibilityNote, peers,
//     homeDir? })  ← new, multi-agent-aware. Wizard install loop
//     uses this so every agent's SOUL.md cross-references its peers.
export function applyForemanSoul(
  entry: AgentEntry,
  soulPath: string,
  homeDir?: string,
): ApplyForemanSoulResult | null;
export function applyForemanSoul(
  input: ApplyForemanSoulInput,
): ApplyForemanSoulResult | null;
export function applyForemanSoul(
  entryOrInput: AgentEntry | ApplyForemanSoulInput,
  soulPath?: string,
  homeDir?: string,
): ApplyForemanSoulResult | null {
  const input: ApplyForemanSoulInput = isApplyInput(entryOrInput)
    ? entryOrInput
    : {
        entry: entryOrInput,
        soulPath: soulPath ?? "",
        responsibilityNote: null,
        peers: [],
        homeDir,
      };
  if (!input.entry.identity_path) return null;
  const home = input.homeDir ?? homedir();
  const target = expandHome(input.entry.identity_path, home);
  const template = readForemanSoul(input.soulPath);
  const desired = renderSoulForAgent(template, {
    agentId: input.entry.id,
    responsibilityNote: input.responsibilityNote ?? null,
    peers: input.peers ?? [],
  });
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : null;
  if (existing === desired) return { path: target, changed: false };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, desired, "utf-8");
  return { path: target, changed: true };
}

function isApplyInput(
  v: AgentEntry | ApplyForemanSoulInput,
): v is ApplyForemanSoulInput {
  return (
    typeof v === "object" &&
    v !== null &&
    "entry" in v &&
    "soulPath" in v
  );
}

export interface RenderSoulContext {
  agentId: string;
  responsibilityNote?: string | null | undefined;
  peers?: PeerAgent[] | undefined;
}

/**
 * Substitute all SOUL template placeholders with concrete per-agent
 * values. Pure helper — same template, different output per agent.
 *
 * Supported tokens:
 *   - {agent_id}            → the agent's registered id (always present)
 *   - {responsibility}      → registered responsibility note OR a generic
 *                             "general-purpose assistant" fallback
 *   - {peer_agents_block}   → multi-line list of other registered agents
 *                             with their responsibilities, OR a single
 *                             "(no peer agents on this machine yet)" line
 *
 * Backward-compatible signature: callers that only know the agent id can
 * still call renderSoulForAgent(template, "hermes"). New shape:
 * renderSoulForAgent(template, { agentId, responsibilityNote, peers }).
 */
export function renderSoulForAgent(template: string, agentId: string): string;
export function renderSoulForAgent(
  template: string,
  ctx: RenderSoulContext,
): string;
export function renderSoulForAgent(
  template: string,
  agentIdOrCtx: string | RenderSoulContext,
): string {
  const ctx: RenderSoulContext =
    typeof agentIdOrCtx === "string"
      ? { agentId: agentIdOrCtx }
      : agentIdOrCtx;
  const responsibility = ctx.responsibilityNote?.trim()
    ? ctx.responsibilityNote.trim()
    : "general-purpose assistant on this machine";
  const peerBlock = renderPeerBlock(ctx.peers ?? []);
  return template
    .replace(/\{agent_id\}/g, ctx.agentId)
    .replace(/\{responsibility\}/g, responsibility)
    .replace(/\{peer_agents_block\}/g, peerBlock);
}

function renderPeerBlock(peers: PeerAgent[]): string {
  if (peers.length === 0) {
    return "(no peer agents on this machine yet — you're the only one)";
  }
  return peers
    .map((p) => {
      const role = p.responsibilityNote?.trim()
        ? p.responsibilityNote.trim()
        : "general-purpose";
      const label = p.displayName ?? p.id;
      return `- \`${p.id}\` — ${role} (${label})`;
    })
    .join("\n");
}

function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return resolve(homeDir, p.slice(2));
  return p;
}
