import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRETOOLUSE_MATCHER,
  defaultHookCommand,
  FOREMAN_HOOK_MARKER,
  FOREMAN_HOOK_TIMEOUT_SECONDS,
  hasForemanHook,
  installPreToolUseHook,
  mergeHook,
  projectSettingsPath,
  resolveHookLauncher,
  uninstallPreToolUseHook,
} from "../../src/core/agent-hook.js";

// =============================================================================
// #517 Faz 4 — PreToolUse hook installer. Adds a `hooks.PreToolUse` entry
// to the agent's settings.json that pipes risky tool calls through Foreman
// (`foreman hook claude-code`). Idempotent, marker-tagged so uninstall
// finds OUR entry without guessing by command-string match.
// =============================================================================

describe("mergeHook — pure merge logic", () => {
  it("adds a fresh PreToolUse group when settings has no hooks block", () => {
    const { next, alreadyInstalled } = mergeHook(
      {},
      { matcher: "Bash", hookCommand: "foreman hook claude-code" },
    );
    expect(alreadyInstalled).toBe(false);
    expect(next.hooks?.PreToolUse).toHaveLength(1);
    const group = next.hooks!.PreToolUse![0]!;
    expect(group.matcher).toBe("Bash");
    expect(group.hooks?.[0]?.command).toBe("foreman hook claude-code");
    expect(group.hooks?.[0]?.managed_by).toBe(FOREMAN_HOOK_MARKER);
    expect(group.hooks?.[0]?.type).toBe("command");
  });

  it("appends a new group alongside existing PreToolUse entries", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [{ type: "command", command: "/usr/local/bin/my-hook" }],
          },
        ],
      },
    };
    const { next, alreadyInstalled } = mergeHook(existing, {
      matcher: "Bash",
      hookCommand: "foreman hook claude-code",
    });
    expect(alreadyInstalled).toBe(false);
    expect(next.hooks!.PreToolUse).toHaveLength(2);
    // The user's hook stays first + intact.
    expect(next.hooks!.PreToolUse![0]!.hooks?.[0]?.command).toBe(
      "/usr/local/bin/my-hook",
    );
    expect(next.hooks!.PreToolUse![0]!.hooks?.[0]?.managed_by).toBeUndefined();
  });

  it("idempotent — second call finds the Foreman marker + returns alreadyInstalled", () => {
    const first = mergeHook(
      {},
      { matcher: "Bash", hookCommand: "foreman hook claude-code" },
    );
    const second = mergeHook(first.next, {
      matcher: "Bash",
      hookCommand: "foreman hook claude-code",
    });
    expect(second.alreadyInstalled).toBe(true);
    // Doesn't duplicate the group on re-merge.
    expect(second.next.hooks?.PreToolUse).toHaveLength(1);
  });

  it("preserves unrelated keys on the settings object", () => {
    const existing = {
      permissions: { allow: ["Bash(git:*)"] },
      mcpServers: { foreman: { command: "foreman" } },
    } as Record<string, unknown>;
    const { next } = mergeHook(existing, {
      matcher: "Bash",
      hookCommand: "foreman hook claude-code",
    });
    expect(next.permissions).toEqual(existing.permissions);
    expect(next.mcpServers).toEqual(existing.mcpServers);
  });

  it("matches by marker, NOT by command string, and rewrites a command that drifted (#714)", () => {
    // First install pretends `foreman` lived in /nvm/v20/bin/foreman.
    const first = mergeHook(
      {},
      { matcher: "Bash", hookCommand: "/Users/fatih/.nvm/v20/bin/foreman hook claude-code" },
    );
    // Second install uses a different path (e.g. brew now in PATH first).
    // The marker still finds the entry: no duplicate, the command is updated.
    const second = mergeHook(first.next, {
      matcher: "Bash",
      hookCommand: "/opt/homebrew/bin/foreman hook claude-code",
    });
    expect(second.alreadyInstalled).toBe(false);
    expect(second.updated).toBe(true);
    expect(second.next.hooks?.PreToolUse).toHaveLength(1);
    expect(second.next.hooks?.PreToolUse?.[0]?.hooks?.[0]).toMatchObject({
      command: "/opt/homebrew/bin/foreman hook claude-code",
      managed_by: FOREMAN_HOOK_MARKER,
    });
    // The same command again: untouched.
    const third = mergeHook(second.next, { matcher: "Bash", hookCommand: "/opt/homebrew/bin/foreman hook claude-code" });
    expect(third).toMatchObject({ alreadyInstalled: true, updated: false });
  });

  it("upgrades a bare 2.2.0 hook in place, keeping the user's own hooks (#714)", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] },
          { matcher: DEFAULT_PRETOOLUSE_MATCHER, hooks: [{ type: "command", command: "foreman-hook claude-code", timeout: 660, managed_by: FOREMAN_HOOK_MARKER }] },
        ],
      },
    };
    const pinned = defaultHookCommand("claude-code", { argv: ["/opt/node/bin/node", "/opt/foreman/dist/cli/hook.js"] }, "darwin");
    const { next, updated } = mergeHook(existing, { matcher: DEFAULT_PRETOOLUSE_MATCHER, hookCommand: pinned });
    expect(updated).toBe(true);
    expect(next.hooks?.PreToolUse?.[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(next.hooks?.PreToolUse?.[1]?.hooks?.[0]?.command).toBe(pinned);
    expect(hasForemanHook(next, "claude-code")).toBe(true);
  });
});

describe("installPreToolUseHook — disk I/O", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-hook-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the settings file when it doesn't exist", () => {
    const settingsPath = join(tmp, "fresh.json");
    expect(existsSync(settingsPath)).toBe(false);
    const result = installPreToolUseHook({
      settingsPath,
      hookCommand: "foreman hook claude-code",
    });
    expect(result.unchanged).toBe(false);
    expect(existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(written.hooks.PreToolUse[0]!.matcher).toBe(
      DEFAULT_PRETOOLUSE_MATCHER,
    );
    // Every tool that can read or change files is gated; Grep prints file
    // contents, so it is as sensitive as Read.
    const matcher = new RegExp(`^(${DEFAULT_PRETOOLUSE_MATCHER})$`);
    for (const tool of ["Bash", "Read", "Grep", "Glob", "Write", "NotebookEdit", "mcp__x__y"]) {
      expect(matcher.test(tool)).toBe(true);
    }
  });

  it("merges into an existing settings file without dropping user keys", () => {
    const settingsPath = join(tmp, "existing.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["Bash(git:*)"] },
        my_custom_field: 42,
      }),
      "utf-8",
    );
    installPreToolUseHook({
      settingsPath,
      hookCommand: "foreman hook claude-code",
    });
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      permissions: { allow: string[] };
      my_custom_field: number;
      hooks: unknown;
    };
    expect(written.permissions.allow).toEqual(["Bash(git:*)"]);
    expect(written.my_custom_field).toBe(42);
    expect(written.hooks).toBeDefined();
  });

  it("respects --dry-run — file untouched, result.unchanged=false on first install", () => {
    const settingsPath = join(tmp, "dryrun.json");
    const result = installPreToolUseHook({
      settingsPath,
      hookCommand: "foreman hook claude-code",
      dryRun: true,
    });
    expect(result.alreadyInstalled).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("second run reports alreadyInstalled + leaves file bit-identical", () => {
    const settingsPath = join(tmp, "twice.json");
    installPreToolUseHook({
      settingsPath,
      hookCommand: "foreman hook claude-code",
    });
    const first = readFileSync(settingsPath, "utf-8");
    const second = installPreToolUseHook({
      settingsPath,
      hookCommand: "foreman hook claude-code",
    });
    expect(second.alreadyInstalled).toBe(true);
    expect(second.unchanged).toBe(true);
    // No writes happened on the second run.
    expect(readFileSync(settingsPath, "utf-8")).toBe(first);
  });

  it("custom matcher lands on disk verbatim", () => {
    const settingsPath = join(tmp, "matcher.json");
    installPreToolUseHook({
      settingsPath,
      hookCommand: "foreman hook claude-code",
      matcher: "Bash",
    });
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(written.hooks.PreToolUse[0]!.matcher).toBe("Bash");
  });

  it("throws a friendly error on corrupt JSON instead of silently overwriting", () => {
    const settingsPath = join(tmp, "corrupt.json");
    writeFileSync(settingsPath, "{ not json", "utf-8");
    expect(() =>
      installPreToolUseHook({
        settingsPath,
        hookCommand: "foreman hook claude-code",
      }),
    ).toThrow(/Cannot parse/);
  });
});

describe("uninstallPreToolUseHook", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-hook-uninstall-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes ONLY the Foreman-managed hook entry, leaves user entries", () => {
    const settingsPath = join(tmp, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "/usr/local/bin/my-hook" },
                {
                  type: "command",
                  command: "foreman hook claude-code",
                  managed_by: FOREMAN_HOOK_MARKER,
                },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );
    const result = uninstallPreToolUseHook(settingsPath);
    expect(result.removed).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: {
        PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    };
    expect(written.hooks.PreToolUse[0]!.hooks).toHaveLength(1);
    expect(written.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(
      "/usr/local/bin/my-hook",
    );
  });

  it("drops the entire group when the Foreman hook was the only entry", () => {
    const settingsPath = join(tmp, "solo.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "foreman hook claude-code",
                  managed_by: FOREMAN_HOOK_MARKER,
                },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );
    uninstallPreToolUseHook(settingsPath);
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(written.hooks.PreToolUse).toEqual([]);
  });

  it("returns removed=false when no Foreman hook is present (no-op)", () => {
    const settingsPath = join(tmp, "clean.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "/usr/local/bin/my-hook" }],
            },
          ],
        },
      }),
      "utf-8",
    );
    const before = readFileSync(settingsPath, "utf-8");
    const result = uninstallPreToolUseHook(settingsPath);
    expect(result.removed).toBe(false);
    // File untouched — no spurious writes when there's nothing to remove.
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("respects --dry-run", () => {
    const settingsPath = join(tmp, "dry.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "foreman hook claude-code",
                  managed_by: FOREMAN_HOOK_MARKER,
                },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );
    const before = readFileSync(settingsPath, "utf-8");
    const result = uninstallPreToolUseHook(settingsPath, { dryRun: true });
    expect(result.removed).toBe(true);
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});

describe("hook entry hardening", () => {
  it("writes a runner timeout longer than Foreman's own approval window", () => {
    const { next } = mergeHook(
      {},
      { matcher: "Bash", hookCommand: "foreman hook claude-code" },
    );
    const entry = next.hooks!.PreToolUse![0]!.hooks![0]!;
    expect(entry.timeout).toBe(FOREMAN_HOOK_TIMEOUT_SECONDS);
    expect(FOREMAN_HOOK_TIMEOUT_SECONDS).toBeGreaterThan(600);
  });

  it("gates Read and third-party MCP tools by default", () => {
    const re = new RegExp(`^(?:${DEFAULT_PRETOOLUSE_MATCHER})$`);
    for (const tool of ["Bash", "Read", "Write", "Edit", "WebFetch", "mcp__github__create_issue"]) {
      expect(re.test(tool)).toBe(true);
    }
  });
});

describe("defaultHookCommand (#714)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-hook-path-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("pins node and hook.js next to the CLI by absolute path", () => {
    mkdirSync(join(dir, "dist", "cli"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli", "index.js"), "");
    writeFileSync(join(dir, "dist", "cli", "hook.js"), "");
    symlinkSync(join(dir, "dist", "cli", "index.js"), join(dir, "foreman"));
    const launcher = resolveHookLauncher({ execPath: "/opt/node/bin/node", cliEntry: join(dir, "foreman"), isSea: false });
    expect(launcher.argv).toEqual(["/opt/node/bin/node", join(realpathSync(dir), "dist", "cli", "hook.js")]);
  });

  it("runs the CLI's own `hook` command when hook.js isn't there, and the binary itself when standalone", () => {
    writeFileSync(join(dir, "index.js"), "");
    expect(resolveHookLauncher({ execPath: "/n/node", cliEntry: join(dir, "index.js"), isSea: false }).argv).toEqual([
      "/n/node",
      join(realpathSync(dir), "index.js"),
      "hook",
    ]);
    expect(resolveHookLauncher({ execPath: "/usr/local/bin/foreman", isSea: true }).argv).toEqual(["/usr/local/bin/foreman", "hook"]);
  });

  it("quotes paths with spaces and never relies on PATH", () => {
    const cmd = defaultHookCommand(
      "claude-code",
      { argv: ["/Users/a b/.nvm/versions/node/v22/bin/node", "/Users/a b/lib/node_modules/foreman-agent/dist/cli/hook.js"] },
      "darwin",
    );
    expect(cmd.startsWith("'/Users/a b/.nvm/versions/node/v22/bin/node' '/Users/a b/lib/node_modules/foreman-agent/dist/cli/hook.js' claude-code;")).toBe(true);
    expect(hasForemanHook({ hooks: { PreToolUse: [{ hooks: [{ command: cmd, managed_by: FOREMAN_HOOK_MARKER }] }] } }, "claude-code")).toBe(true);
    expect(hasForemanHook({ hooks: { PreToolUse: [{ hooks: [{ command: cmd, managed_by: FOREMAN_HOOK_MARKER }] }] } }, "codex")).toBe(false);
    expect(defaultHookCommand("claude-code", { argv: ["C:\\Program Files\\nodejs\\node.exe", "C:\\f\\hook.js"] }, "win32")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" C:\\f\\hook.js claude-code',
    );
  });

  it("still recognises the bare 2.2.0 shapes", () => {
    for (const command of ["foreman-hook claude-code", "foreman hook claude-code", "/opt/homebrew/bin/foreman-hook claude-code"]) {
      expect(hasForemanHook({ hooks: { PreToolUse: [{ hooks: [{ command, managed_by: FOREMAN_HOOK_MARKER }] }] } }, "claude-code")).toBe(true);
    }
  });

  // What Claude Code sees: 0 runs the call, 2 blocks it, anything else is a
  // non-blocking error that also runs it. The wrapper keeps 0 and 2 and
  // turns everything else into 2.
  it.skipIf(process.platform === "win32")("blocks (exit 2) when the hook can't start or fails, and passes 0 and 2 through", () => {
    const stub = (code: number): string => {
      const file = join(dir, `hook-${code}.sh`);
      writeFileSync(file, `cat >/dev/null; exit ${code}\n`);
      return file;
    };
    const run = (argv: string[]) =>
      spawnSync("/bin/sh", ["-c", defaultHookCommand("claude-code", { argv }, "darwin")], { input: "{}", encoding: "utf-8" });
    expect(run(["/bin/sh", stub(0)]).status).toBe(0);
    expect(run(["/bin/sh", stub(2)]).status).toBe(2);
    const failed = run(["/bin/sh", stub(1)]);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain("Foreman's hook could not run (exit 1), so this call is blocked");
    // The program is gone: 127 from the shell, blocked all the same.
    const missing = run([join(dir, "no-such-node"), join(dir, "no-such-hook.js")]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("so this call is blocked");
  });

  it("puts a project hook in <dir>/.claude/settings.json", () => {
    expect(projectSettingsPath(dir)).toBe(join(dir, ".claude", "settings.json"));
    installPreToolUseHook({ settingsPath: projectSettingsPath(dir), hookCommand: "foreman hook claude-code" });
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")).hooks.PreToolUse).toHaveLength(1);
  });
});
