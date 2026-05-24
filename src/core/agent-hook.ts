import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// PreToolUse hook installer (#517 Faz 4)
// =============================================================================
//
// The real gateway. Faz 1-3 either ship a curated allowlist or let the
// operator opt out of one entirely — neither covers the case where an
// honest agent hits a command it wasn't pre-authorised for but the user
// would gladly approve once. The PreToolUse hook closes that loop:
// agent → hook fires → Foreman pushes an approval to Telegram → user
// taps Allow → hook exits 0 → agent's call proceeds. No more "denied,
// here's what I tried" failure mode.
//
// This module owns just the settings.json injection. The hook script
// itself lives in `cli/hook-cli.ts` (`foreman hook <agent>`).
//
// Coverage today: claude-code only. Codex / OpenClaw don't expose an
// equivalent pre-call hook (Codex is MCP-only, OpenClaw routes through
// its own gating layer). Hermes's plugin model could host one but is
// scope creep here.

export const FOREMAN_HOOK_MARKER = "foreman.pre-tool-use" as const;

/** Default tool matcher — every tool Claude Code surfaces that could
 *  actually do harm. Reads (e.g. `Read`) intentionally not matched;
 *  Foreman's MCP layer already scores those + the chain analysis (#526)
 *  catches read-then-leak patterns better than a per-Read prompt would. */
export const DEFAULT_PRETOOLUSE_MATCHER = "Bash|Write|Edit|WebFetch" as const;

export interface InstallHookInput {
  /** Path to the agent's settings.json (e.g. ~/.claude/settings.json).
   *  Created if missing; merged non-destructively otherwise. */
  settingsPath: string;
  /** The hook command Claude Code should run before every matching tool
   *  call. Production wires this to `foreman hook claude-code`; tests
   *  pass a stub. */
  hookCommand: string;
  /** Regex-shaped tool matcher. Defaults to DEFAULT_PRETOOLUSE_MATCHER. */
  matcher?: string;
  /** When true, return the merged settings without touching disk. */
  dryRun?: boolean;
}

export interface InstallHookResult {
  /** Path actually written (or that would be written). */
  settingsPath: string;
  /** True when an existing Foreman hook entry was found + left intact. */
  alreadyInstalled: boolean;
  /** True when nothing changed (alreadyInstalled OR dryRun no-op). */
  unchanged: boolean;
  /** Matcher value the hook entry was written with. Surfaces in the CLI
   *  confirmation so the user sees what's gated. */
  matcher: string;
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookGroup[];
    [k: string]: HookGroup[] | undefined;
  };
  [k: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

interface HookEntry {
  type?: string;
  command?: string;
  /** Foreman-only metadata so we can find our entry on uninstall without
   *  guessing by command string (paths drift across npm prefixes). */
  managed_by?: typeof FOREMAN_HOOK_MARKER;
}

/** Merge a PreToolUse hook entry pointing at Foreman into the agent's
 *  settings.json. Idempotent — second run finds the marker + returns
 *  alreadyInstalled. Non-destructive — never touches unrelated keys
 *  (mcpServers, permissions, model overrides…). */
export function installPreToolUseHook(
  input: InstallHookInput,
): InstallHookResult {
  const matcher = input.matcher ?? DEFAULT_PRETOOLUSE_MATCHER;
  const existing = readSettings(input.settingsPath);
  const { next, alreadyInstalled } = mergeHook(existing, {
    matcher,
    hookCommand: input.hookCommand,
  });
  const unchanged = alreadyInstalled;
  if (!input.dryRun && !unchanged) {
    mkdirSync(dirname(input.settingsPath), { recursive: true });
    writeFileSync(
      input.settingsPath,
      JSON.stringify(next, null, 2) + "\n",
      "utf-8",
    );
  }
  return {
    settingsPath: input.settingsPath,
    alreadyInstalled,
    unchanged,
    matcher,
  };
}

export interface UninstallHookResult {
  settingsPath: string;
  /** True when a Foreman-managed hook entry was actually removed. */
  removed: boolean;
}

/** Remove every Foreman-managed PreToolUse hook entry. User-added hook
 *  entries are left alone — we only touch ones tagged with
 *  `managed_by: FOREMAN_HOOK_MARKER`. */
export function uninstallPreToolUseHook(
  settingsPath: string,
  opts: { dryRun?: boolean } = {},
): UninstallHookResult {
  const existing = readSettings(settingsPath);
  const groups = existing.hooks?.PreToolUse ?? [];
  const filteredGroups: HookGroup[] = [];
  let removed = false;
  for (const group of groups) {
    const remainingHooks = (group.hooks ?? []).filter((h) => {
      if (h.managed_by === FOREMAN_HOOK_MARKER) {
        removed = true;
        return false;
      }
      return true;
    });
    if (remainingHooks.length > 0) {
      filteredGroups.push({ ...group, hooks: remainingHooks });
    }
    // A group that ONLY had a Foreman hook drops out entirely.
  }
  if (!removed) {
    return { settingsPath, removed: false };
  }
  const next: ClaudeSettings = {
    ...existing,
    hooks: {
      ...(existing.hooks ?? {}),
      PreToolUse: filteredGroups,
    },
  };
  // Empty PreToolUse array stays in place — harmless + lets the user see
  // there WAS a hook. The hooks object stays.
  if (!opts.dryRun) {
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  }
  return { settingsPath, removed };
}

/** Pure merge helper. Exposed for tests so they can poke the logic
 *  without going to disk. */
export function mergeHook(
  existing: ClaudeSettings,
  input: { matcher: string; hookCommand: string },
): { next: ClaudeSettings; alreadyInstalled: boolean } {
  const groups = existing.hooks?.PreToolUse ?? [];
  // Look for an existing Foreman-managed entry — match by marker, NOT by
  // command string (paths drift across npm prefixes, brew bins, dev
  // checkouts).
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (hook.managed_by === FOREMAN_HOOK_MARKER) {
        // Already installed. Idempotent return.
        return { next: existing, alreadyInstalled: true };
      }
    }
  }
  const newGroup: HookGroup = {
    matcher: input.matcher,
    hooks: [
      {
        type: "command",
        command: input.hookCommand,
        managed_by: FOREMAN_HOOK_MARKER,
      },
    ],
  };
  const next: ClaudeSettings = {
    ...existing,
    hooks: {
      ...(existing.hooks ?? {}),
      PreToolUse: [...groups, newGroup],
    },
  };
  return { next, alreadyInstalled: false };
}

function readSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read settings at ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ClaudeSettings;
    }
  } catch {
    throw new Error(
      `Cannot parse existing settings at ${settingsPath} — fix the JSON ` +
        `(or move the file aside) and re-run.`,
    );
  }
  return {};
}
