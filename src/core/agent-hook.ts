import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

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

/** Default tool matcher — every Claude Code tool that can do harm or read
 *  secrets. `Read` is included because Claude Code's built-in Read never
 *  passes through Foreman's MCP layer: without it, "read ~/.ssh/id_rsa"
 *  would bypass every secret-path rule. Third-party MCP tools (`mcp__…`)
 *  are matched too; Foreman's own `mcp__foreman__…` tools are skipped by
 *  the hook because `foreman mcp-stdio` already mediates them, but only
 *  when no project config swapped in another `foreman` server (#619,
 *  foreman-mcp-trust.ts). Everyday
 *  reads still pass without a prompt — the policy only asks for
 *  secret-shaped paths. */
export const DEFAULT_PRETOOLUSE_MATCHER =
  "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|mcp__.*" as const;

/** Seconds Claude Code waits for the hook. Must exceed Foreman's own
 *  approval window (600s) so a pending approval is resolved by the human —
 *  or denied by Foreman — rather than abandoned by a runner timeout. */
export const FOREMAN_HOOK_TIMEOUT_SECONDS = 660;

/** Agents with a pre-call hook Foreman can install: Claude Code's
 *  PreToolUse. Others (Codex, OpenClaw, Hermes) don't expose one. */
export function supportsPreToolUseHook(agentId: string): boolean {
  return agentId === "claude-code";
}

// -----------------------------------------------------------------------------
// The hook command (#714)
// -----------------------------------------------------------------------------
//
// Claude Code runs the hook through a shell and treats every exit code other
// than 2 as a non-blocking error: the tool call then runs. A bare
// `foreman-hook claude-code` that isn't on the PATH Claude Code sees (another
// nvm default, Foreman uninstalled, a moved Node) exits 127 and the call runs
// unguarded. So the command names its programs by absolute path, and a
// wrapper turns any exit other than 0 (allow) or 2 (block) into a block.

/** The programs that run the hook: `[node, …/dist/cli/hook.js]` for an npm
 *  or Homebrew install, `[node, …/cli/index.js, "hook"]` when hook.js isn't
 *  next to the CLI, `[foreman, "hook"]` for a standalone binary. */
export interface HookLauncher {
  argv: string[];
}

export interface HookLauncherProbe {
  execPath?: string;
  /** The CLI entry this process runs (process.argv[1]). */
  cliEntry?: string;
  isSea?: boolean;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
}

export function resolveHookLauncher(probe: HookLauncherProbe = {}): HookLauncher {
  const execPath = probe.execPath ?? process.execPath;
  if (probe.isSea ?? runningAsSea()) return { argv: [execPath, "hook"] };
  const exists = probe.exists ?? existsSync;
  const realpath = probe.realpath ?? realpathSync;
  const entry = probe.cliEntry ?? process.argv[1];
  if (entry) {
    let cli: string;
    try {
      cli = realpath(entry);
    } catch {
      cli = entry;
    }
    const hook = join(dirname(cli), "hook.js");
    if (exists(hook)) return { argv: [execPath, hook] };
    if (exists(cli)) return { argv: [execPath, cli, "hook"] };
  }
  // Nothing to pin (an unusual embedding): the CLI by name, still wrapped.
  return { argv: ["foreman", "hook"] };
}

function runningAsSea(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}

/** The command written into the agent's settings (see above). */
export function defaultHookCommand(
  agentId: string,
  launcher: HookLauncher = resolveHookLauncher(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    // cmd.exe: no wrapper; absolute, quoted paths still avoid the PATH.
    return [...launcher.argv.map(winQuote), agentId].join(" ");
  }
  const run = [...launcher.argv.map(shQuote), agentId].join(" ");
  return `${run}; s=$?; [ "$s" -eq 0 ] || [ "$s" -eq 2 ] || { echo "${HOOK_FAILED_TEXT}" >&2; s=2; }; exit "$s"`;
}

/** What the wrapper prints when it blocks. The usual cause is Foreman's
 *  package (or its Node) being gone, so `foreman doctor` alone can't help:
 *  it names both ways out, reinstalling or removing this hook entry. Goes
 *  in a double-quoted sh string: `$s` is the exit status, and it must hold
 *  no other `$`, `"`, backquote or `\`. */
export const HOOK_FAILED_TEXT =
  "Foreman's hook could not run (exit $s), so this call is blocked. " +
  "If Foreman was uninstalled or its Node removed, reinstall it (npm install -g foreman-agent), " +
  "or remove Foreman's entry (managed_by: foreman.pre-tool-use) under hooks.PreToolUse in Claude Code's settings.json. " +
  "Otherwise run: foreman doctor";

/** An argument for sh: bare when it's safe as is, else single-quoted. */
function shQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function winQuote(arg: string): string {
  return /^[A-Za-z0-9_:.\\/-]+$/.test(arg) ? arg : `"${arg}"`;
}

/** Claude Code's project settings in `dir`: a hook there covers only
 *  sessions started in that project (`--project`). */
export function projectSettingsPath(dir: string): string {
  return join(resolve(dir), ".claude", "settings.json");
}

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
  /** True when an existing Foreman hook entry ran another command (e.g. a
   *  bare `foreman-hook claude-code` from 2.2.0) and was rewritten. */
  updated: boolean;
  /** True when nothing changed (alreadyInstalled OR dryRun no-op). */
  unchanged: boolean;
  /** Matcher value the hook entry was written with. Surfaces in the CLI
   *  confirmation so the user sees what's gated. */
  matcher: string;
}

export interface ClaudeSettings {
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
  timeout?: number;
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
  const { next, alreadyInstalled, updated } = mergeHook(existing, {
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
    updated,
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
  const next = stripForemanHooks(readSettings(settingsPath));
  if (next === null) {
    return { settingsPath, removed: false };
  }
  if (!opts.dryRun) {
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  }
  return { settingsPath, removed: true };
}

/** Pure: `existing` without its Foreman-managed PreToolUse hook entries,
 *  or null when it has none. With `agentId`, only the entries whose
 *  command runs the hook for that agent (`foreman hook <agentId>`,
 *  `foreman-hook <agentId>`) go. User-added entries always stay. */
export function stripForemanHooks(
  existing: ClaudeSettings,
  agentId?: string,
): ClaudeSettings | null {
  const groups = existing.hooks?.PreToolUse ?? [];
  if (!Array.isArray(groups)) return null;
  const filteredGroups: HookGroup[] = [];
  let removed = false;
  for (const group of groups) {
    const remainingHooks = (group.hooks ?? []).filter((h) => {
      if (h.managed_by === FOREMAN_HOOK_MARKER && (agentId === undefined || hookRunsFor(h, agentId))) {
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
  if (!removed) return null;
  // Empty PreToolUse array stays in place — harmless + lets the user see
  // there WAS a hook. The hooks object stays.
  return {
    ...existing,
    hooks: {
      ...(existing.hooks ?? {}),
      PreToolUse: filteredGroups,
    },
  };
}

/** Whether Foreman's PreToolUse hook for `agentId` is in these settings. */
export function hasForemanHook(settings: ClaudeSettings, agentId: string): boolean {
  return stripForemanHooks(settings, agentId) !== null;
}

/** Whether a Foreman hook command runs the hook for `agentId`: the
 *  argument after `foreman-hook`, `… hook` or `…/hook.js`, in the bare
 *  2.2.0 shape and the pinned, wrapped one (#714). */
function hookRunsFor(hook: HookEntry, agentId: string): boolean {
  if (typeof hook.command !== "string") return false;
  const id = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s'"/\\\\])(?:foreman-hook|hook(?:\\.js)?)['"]?\\s+${id}(?=[\\s;"']|$)`).test(hook.command);
}

/** The Foreman hook entries in these settings (any agent). */
export function foremanHookCommands(settings: ClaudeSettings): string[] {
  return (settings.hooks?.PreToolUse ?? []).flatMap((g) =>
    (g.hooks ?? []).filter((h) => h.managed_by === FOREMAN_HOOK_MARKER && typeof h.command === "string").map((h) => h.command as string),
  );
}

/** Pure merge helper. Exposed for tests so they can poke the logic
 *  without going to disk. An existing Foreman entry is kept when it runs
 *  the same command, and rewritten when it doesn't: installing again is how
 *  a hook that relied on PATH (#714) gets pinned. */
export function mergeHook(
  existing: ClaudeSettings,
  input: { matcher: string; hookCommand: string },
): { next: ClaudeSettings; alreadyInstalled: boolean; updated: boolean } {
  const groups = existing.hooks?.PreToolUse ?? [];
  // Look for an existing Foreman-managed entry — match by marker, NOT by
  // command string (paths drift across npm prefixes, brew bins, dev
  // checkouts).
  for (const [gi, group] of groups.entries()) {
    for (const [hi, hook] of (group.hooks ?? []).entries()) {
      if (hook.managed_by !== FOREMAN_HOOK_MARKER) continue;
      if (hook.command === input.hookCommand) {
        return { next: existing, alreadyInstalled: true, updated: false };
      }
      const nextGroups = groups.map((g, i) =>
        i !== gi
          ? g
          : {
              ...g,
              hooks: (g.hooks ?? []).map((h, j) =>
                j !== hi ? h : { ...h, command: input.hookCommand, timeout: FOREMAN_HOOK_TIMEOUT_SECONDS },
              ),
            },
      );
      return {
        next: { ...existing, hooks: { ...(existing.hooks ?? {}), PreToolUse: nextGroups } },
        alreadyInstalled: false,
        updated: true,
      };
    }
  }
  const newGroup: HookGroup = {
    matcher: input.matcher,
    hooks: [
      {
        type: "command",
        command: input.hookCommand,
        timeout: FOREMAN_HOOK_TIMEOUT_SECONDS,
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
  return { next, alreadyInstalled: false, updated: false };
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
