import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRETOOLUSE_MATCHER,
  FOREMAN_HOOK_MARKER,
  installPreToolUseHook,
  mergeHook,
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

  it("matches by marker, NOT by command string (path-drift resilient)", () => {
    // First install pretends `foreman` lived in /nvm/v20/bin/foreman.
    const first = mergeHook(
      {},
      { matcher: "Bash", hookCommand: "/Users/fatih/.nvm/v20/bin/foreman hook claude-code" },
    );
    // Second install uses a different path (e.g. brew now in PATH first).
    // The marker still finds the entry — no duplicate.
    const second = mergeHook(first.next, {
      matcher: "Bash",
      hookCommand: "/opt/homebrew/bin/foreman hook claude-code",
    });
    expect(second.alreadyInstalled).toBe(true);
    expect(second.next.hooks?.PreToolUse).toHaveLength(1);
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
