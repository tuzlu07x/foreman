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
  applyPermissions,
  DEFAULT_PERMISSIONS,
  DESTRUCTIVE_FORBIDDEN,
  mergePermissions,
  resolveAgentSettingsPath,
} from "../../src/core/agent-permissions.js";

// =============================================================================
// #518 — sensible permission defaults for spawned agents
//
// Pins the contract: merging is non-destructive, idempotent, and never
// auto-adds destructive commands.
// =============================================================================

describe("mergePermissions — pure merge logic", () => {
  it("adds the full default allowlist into an empty settings object", () => {
    const defaults = DEFAULT_PERMISSIONS["claude-code"]!;
    const { next, added, kept } = mergePermissions({}, defaults);
    expect(next.permissions?.allow).toEqual(defaults.allow);
    expect(added).toEqual(defaults.allow);
    expect(kept).toEqual([]);
  });

  it("preserves unrelated keys on the settings object", () => {
    const defaults = DEFAULT_PERMISSIONS["claude-code"]!;
    const existing = {
      hooks: { PreToolUse: "/some/hook.sh" },
      mcpServers: { foreman: { command: "foreman" } },
    } as Record<string, unknown>;
    const { next } = mergePermissions(existing, defaults);
    expect(next.hooks).toEqual(existing.hooks);
    expect(next.mcpServers).toEqual(existing.mcpServers);
  });

  it("preserves existing permission.allow entries the user added (not in defaults)", () => {
    const defaults = DEFAULT_PERMISSIONS["claude-code"]!;
    const existing = {
      permissions: {
        allow: ["Bash(custom-tool:*)", "Bash(git status:*)"],
      },
    };
    const { next, added, kept } = mergePermissions(existing, defaults);
    expect(next.permissions?.allow).toContain("Bash(custom-tool:*)");
    expect(kept).toEqual(["Bash(custom-tool:*)"]);
    // The pre-existing `Bash(git status:*)` IS in defaults so it counts as a
    // dedupe, not a kept-user entry.
    expect(added).not.toContain("Bash(git status:*)");
  });

  it("is idempotent — running twice doesn't duplicate entries", () => {
    const defaults = DEFAULT_PERMISSIONS["claude-code"]!;
    const first = mergePermissions({}, defaults);
    const second = mergePermissions(first.next, defaults);
    expect(second.next.permissions?.allow).toEqual(
      first.next.permissions?.allow,
    );
    expect(second.added).toEqual([]);
  });

  it("preserves existing permissions.deny / .ask blocks untouched", () => {
    const defaults = DEFAULT_PERMISSIONS["claude-code"]!;
    const existing = {
      permissions: {
        allow: [],
        deny: ["Bash(rm:*)"],
        ask: ["Write(/etc/**)"],
      },
    };
    const { next } = mergePermissions(existing, defaults);
    expect(next.permissions?.deny).toEqual(["Bash(rm:*)"]);
    expect(next.permissions?.ask).toEqual(["Write(/etc/**)"]);
  });
});

describe("DEFAULT_PERMISSIONS — invariants", () => {
  it("claude-code defaults exist and are non-trivially large", () => {
    expect(DEFAULT_PERMISSIONS["claude-code"]).toBeDefined();
    expect(DEFAULT_PERMISSIONS["claude-code"]!.allow.length).toBeGreaterThan(
      20,
    );
  });

  it("never includes destructive commands in any default set", () => {
    for (const [agentId, set] of Object.entries(DEFAULT_PERMISSIONS)) {
      for (const forbidden of DESTRUCTIVE_FORBIDDEN) {
        expect(
          set.allow,
          `agent '${agentId}' must not auto-include ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }
  });

  it("covers the commands the user's session blocked on (git clone, gh)", () => {
    const allow = DEFAULT_PERMISSIONS["claude-code"]!.allow;
    expect(allow).toContain("Bash(git clone:*)");
    expect(allow).toContain("Bash(gh:*)");
    expect(allow).toContain("Bash(npm:*)");
  });
});

describe("applyPermissions — disk I/O", () => {
  let tmp: string;
  let settingsPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-perm-"));
    settingsPath = join(tmp, "settings.json");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the settings file when absent + writes defaults", () => {
    const result = applyPermissions("claude-code", settingsPath);
    expect(result.unchanged).toBe(false);
    expect(result.added.length).toBeGreaterThan(20);
    expect(existsSync(settingsPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      permissions?: { allow?: string[] };
    };
    expect(parsed.permissions?.allow).toContain("Bash(git clone:*)");
  });

  it("--dry-run does NOT touch disk", () => {
    expect(existsSync(settingsPath)).toBe(false);
    const result = applyPermissions("claude-code", settingsPath, {
      dryRun: true,
    });
    expect(result.added.length).toBeGreaterThan(0);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("idempotent — second run reports unchanged + added=[]", () => {
    applyPermissions("claude-code", settingsPath);
    const second = applyPermissions("claude-code", settingsPath);
    expect(second.unchanged).toBe(true);
    expect(second.added).toEqual([]);
  });

  it("merges into existing settings without dropping unrelated keys", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: { foreman: { command: "foreman" } },
        permissions: { allow: ["Bash(my-private-script:*)"] },
      }),
      "utf-8",
    );
    const result = applyPermissions("claude-code", settingsPath);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      mcpServers?: unknown;
      permissions?: { allow?: string[] };
    };
    expect(parsed.mcpServers).toEqual({ foreman: { command: "foreman" } });
    expect(parsed.permissions?.allow).toContain("Bash(my-private-script:*)");
    expect(parsed.permissions?.allow).toContain("Bash(git clone:*)");
    expect(result.kept).toContain("Bash(my-private-script:*)");
  });

  it("throws clear error for an unknown agent id", () => {
    expect(() =>
      applyPermissions("not-an-agent", settingsPath),
    ).toThrow(/not-an-agent/);
  });

  it("throws on corrupt existing JSON rather than silently overwriting", () => {
    writeFileSync(settingsPath, "{ this is not valid json", "utf-8");
    expect(() => applyPermissions("claude-code", settingsPath)).toThrow(
      /Cannot parse/,
    );
  });

  it("treats an empty file as fresh-start (no parse error)", () => {
    writeFileSync(settingsPath, "", "utf-8");
    const result = applyPermissions("claude-code", settingsPath);
    expect(result.unchanged).toBe(false);
    expect(result.added.length).toBeGreaterThan(0);
  });
});

describe("resolveAgentSettingsPath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-perm-paths-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the first existing path", () => {
    const a = join(tmp, "a.json");
    const b = join(tmp, "b.json");
    writeFileSync(b, "{}", "utf-8");
    expect(resolveAgentSettingsPath([a, b])).toBe(b);
  });

  it("falls back to the first listed path when none exist", () => {
    const a = join(tmp, "does-not-exist.json");
    const b = join(tmp, "also-not-there.json");
    expect(resolveAgentSettingsPath([a, b])).toBe(a);
  });

  it("expands `~/` against the user's home", () => {
    const resolved = resolveAgentSettingsPath(["~/.fake-agent/settings.json"]);
    expect(resolved).not.toContain("~");
    expect(resolved).toMatch(/\.fake-agent\/settings\.json$/);
  });

  it("throws when config_paths is empty", () => {
    expect(() => resolveAgentSettingsPath([])).toThrow(/no config_paths/);
  });
});
