import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// =============================================================================
// Agent permission defaults (#518 / Agent permission gateway epic #517 — Faz 1)
// =============================================================================
//
// When `foreman write <agent> <task>` spawns Claude Code (or another coding
// agent) in non-interactive mode, the agent's own shell-tool permission
// allowlist gates every `Bash` / `Read` / `Write` call. There's no terminal
// to prompt, so the default behaviour is "deny + report failure" — even for
// obviously-safe commands like `git clone` or `gh repo view`. The user ends
// up on Telegram watching the agent fail to do basic work despite having
// authenticated GitHub etc. earlier in setup.
//
// Foreman ships a curated default allowlist per agent and applies it on
// agent install (and on demand via `foreman agent permissions <id>`). The
// merge is non-destructive: user-added entries are preserved, defaults are
// only added when missing, and destructive commands (`rm`, `sudo`, `curl`
// to arbitrary URLs) are deliberately left OUT — those still need explicit
// user authorization. Faz 1 covers claude-code; codex / openclaw / hermes
// land in Faz 2 of the epic.

/** One Claude-Code-shaped permission entry — `Bash(git:*)`, `Read(/Users/**)`. */
export type PermissionEntry = string;

export interface PermissionSet {
  /** Allowlist entries this agent gets out of the box. */
  allow: PermissionEntry[];
}

/** Defaults per agent id. Keyed by the agent id as it appears in the
 *  registry catalog (`registry/agents.json`). */
export const DEFAULT_PERMISSIONS: Record<string, PermissionSet> = {
  "claude-code": {
    allow: [
      // Read-only git inspection — never modifies state.
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git show:*)",
      "Bash(git branch:*)",
      // State-moving git — fetch / pull / clone are needed even for
      // "just look at the repo"; commit / push / stash for normal coding.
      "Bash(git fetch:*)",
      "Bash(git pull:*)",
      "Bash(git checkout:*)",
      "Bash(git clone:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(git stash:*)",
      "Bash(git merge:*)",
      "Bash(git rebase:*)",
      // GitHub CLI — usually paired with `git clone` for setup work.
      "Bash(gh:*)",
      // Package managers — installs + scripts.
      "Bash(npm:*)",
      "Bash(pnpm:*)",
      "Bash(yarn:*)",
      "Bash(npx:*)",
      "Bash(pip:*)",
      "Bash(pip3:*)",
      "Bash(uv:*)",
      "Bash(poetry:*)",
      // Runtimes / interpreters.
      "Bash(node:*)",
      "Bash(python:*)",
      "Bash(python3:*)",
      "Bash(ruby:*)",
      "Bash(go:*)",
      // Test / build common in CI.
      "Bash(pytest:*)",
      "Bash(jest:*)",
      "Bash(vitest:*)",
      "Bash(make:*)",
      "Bash(cargo:*)",
      "Bash(tsc:*)",
      // Filesystem inspection — read-only.
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(grep:*)",
      "Bash(rg:*)",
      "Bash(find:*)",
      "Bash(wc:*)",
      "Bash(file:*)",
      "Bash(which:*)",
      "Bash(env:*)",
      "Bash(echo:*)",
      "Bash(pwd:*)",
      // Project-tree read/write/edit — scoped to the user's home + /tmp.
      // System dirs (`/etc`, `/var`, `/Library`, `/System`) deliberately
      // excluded — those should require explicit per-task authorization.
      `Read(${homedir()}/**)`,
      "Read(/tmp/**)",
      `Write(${homedir()}/**)`,
      "Write(/tmp/**)",
      `Edit(${homedir()}/**)`,
      "Edit(/tmp/**)",
    ],
  },
};

// Deliberately OUT of every default set — these need per-task user approval
// and should never be auto-added by Foreman. Exported so tests can pin the
// invariant that the merge never silently re-adds them.
export const DESTRUCTIVE_FORBIDDEN: readonly PermissionEntry[] = [
  "Bash(rm:*)",
  "Bash(rmdir:*)",
  "Bash(sudo:*)",
  "Bash(chmod:*)",
  "Bash(chown:*)",
  "Bash(dd:*)",
  "Bash(mkfs:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Write(/etc/**)",
  "Write(/var/**)",
  "Write(/Library/**)",
  "Write(/System/**)",
];

interface ClaudeSettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  [k: string]: unknown;
}

export interface ApplyResult {
  /** Path actually written (or that would be written, for `--dry-run`). */
  settingsPath: string;
  /** Entries Foreman added because they were missing. */
  added: PermissionEntry[];
  /** User-added entries we deliberately did NOT touch. Reported so the user
   *  can see their customisations survived. */
  kept: PermissionEntry[];
  /** True when nothing changed — second run on the same file. */
  unchanged: boolean;
}

/** Merge `defaults.allow` into `existing.permissions.allow`. Adds missing
 *  entries, never removes user-added ones, deduplicates. Pure; tests poke
 *  it without going to disk. */
export function mergePermissions(
  existing: ClaudeSettings,
  defaults: PermissionSet,
): { next: ClaudeSettings; added: PermissionEntry[]; kept: PermissionEntry[] } {
  const priorAllow = existing.permissions?.allow ?? [];
  const seen = new Set(priorAllow);
  const added: PermissionEntry[] = [];
  for (const entry of defaults.allow) {
    if (!seen.has(entry)) {
      seen.add(entry);
      added.push(entry);
    }
  }
  // `kept` = user entries that aren't in our defaults. Lets the CLI tell the
  // user "your customisation X stayed put."
  const defaultSet = new Set(defaults.allow);
  const kept = priorAllow.filter((e) => !defaultSet.has(e));
  const next: ClaudeSettings = {
    ...existing,
    permissions: {
      ...(existing.permissions ?? {}),
      allow: [...seen],
    },
  };
  return { next, added, kept };
}

/** Read settings file (treat missing / empty as `{}`), merge Foreman's
 *  defaults for the agent, write back. Idempotent + non-destructive. */
export function applyPermissions(
  agentId: string,
  settingsPath: string,
  opts: { dryRun?: boolean } = {},
): ApplyResult {
  const defaults = DEFAULT_PERMISSIONS[agentId];
  if (!defaults) {
    throw new Error(
      `No default permission allowlist for agent '${agentId}'. ` +
        `Currently supported in Faz 1: claude-code. See #517 for roadmap.`,
    );
  }
  let existing: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    let raw: string;
    try {
      raw = readFileSync(settingsPath, "utf-8");
    } catch (err) {
      throw new Error(
        `Cannot read settings at ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as ClaudeSettings;
        }
      } catch {
        throw new Error(
          `Cannot parse existing settings at ${settingsPath} — fix the JSON ` +
            `(or move the file aside) and re-run.`,
        );
      }
    }
  }
  const { next, added, kept } = mergePermissions(existing, defaults);
  const unchanged = added.length === 0;
  if (!opts.dryRun && !unchanged) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  }
  return { settingsPath, added, kept, unchanged };
}

/** Pick the agent's settings file from its registry `config_paths` list.
 *  First existing wins; otherwise the first listed path is returned (the
 *  caller will create it). Tildes are expanded against the current home. */
export function resolveAgentSettingsPath(configPaths: string[]): string {
  if (configPaths.length === 0) {
    throw new Error("Agent has no config_paths in the registry");
  }
  const expanded = configPaths.map((p) =>
    p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p,
  );
  for (const p of expanded) {
    if (existsSync(p)) return p;
  }
  return expanded[0]!;
}
