import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOREMAN_HOOK_MARKER } from "../../src/core/agent-hook.js";
import { claudeHookInstalled, codexSandboxFor, roleWorkspace, taskPermissions } from "../../src/core/task-permissions.js";

// What Claude Code and Codex may do on their own during a task Foreman
// hands them (task-permissions.ts). From the 2.3.0 real test: the manager
// (Claude Code) couldn't use Foreman's own tools, and trusting a Codex role
// took its sandbox away entirely.

describe("task permissions", () => {
  it("always lets Claude Code use Foreman's own tools, and skips its prompts only behind Foreman's hook or with trust", () => {
    const base = { runtime: "claude-code", can: undefined } as const;
    expect(taskPermissions({ ...base, trusted: false, hookInstalled: false })!.args).toEqual(["--allowedTools", "mcp__foreman"]);
    expect(taskPermissions({ ...base, trusted: false, hookInstalled: null })!.args).toEqual(["--allowedTools", "mcp__foreman"]);
    expect(taskPermissions({ ...base, trusted: false, hookInstalled: true })!.args).toEqual([
      "--allowedTools",
      "mcp__foreman",
      "--dangerously-skip-permissions",
    ]);
    expect(taskPermissions({ ...base, trusted: true, hookInstalled: false })!.args).toContain("--dangerously-skip-permissions");
    expect(taskPermissions({ ...base, trusted: false, hookInstalled: true })!.summary).toMatch(/through Foreman's hook/);
    expect(taskPermissions({ ...base, trusted: true, hookInstalled: false })!.summary).toMatch(/no Foreman hook installed/);
  });

  it("never runs Codex without its sandbox: read-only until trusted, then its folder only", () => {
    for (const trusted of [false, true]) {
      for (const can of [undefined, [], ["read"], ["read", "write", "shell", "network"]] as const) {
        const args = taskPermissions({ runtime: "codex", trusted, hookInstalled: null, can })!.args;
        expect(args.join(" ")).not.toMatch(/danger|bypass|full-access/);
        expect(args).toContain("--skip-git-repo-check");
        // Its approval policy is "never" headless: Foreman's tools must not need one.
        expect(args).toContain('mcp_servers.foreman.default_tools_approval_mode="approve"');
        expect(args[args.indexOf("--sandbox") + 1]).toMatch(/^(read-only|workspace-write)$/);
      }
    }
    expect(codexSandboxFor({ trusted: false, can: undefined })).toEqual({ sandbox: "read-only", network: false });
    expect(codexSandboxFor({ trusted: true, can: undefined })).toEqual({ sandbox: "workspace-write", network: true });
    expect(taskPermissions({ runtime: "codex", trusted: true, hookInstalled: null, can: undefined })!.args).toEqual([
      "--skip-git-repo-check",
      "-c",
      'mcp_servers.foreman.default_tools_approval_mode="approve"',
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
  });

  it("narrows a trusted Codex to its role: no write or shell means read-only, no network means offline", () => {
    expect(codexSandboxFor({ trusted: true, can: ["read"] })).toEqual({ sandbox: "read-only", network: false });
    expect(codexSandboxFor({ trusted: true, can: [] })).toEqual({ sandbox: "read-only", network: false });
    expect(codexSandboxFor({ trusted: true, can: ["read", "write"] })).toEqual({ sandbox: "workspace-write", network: false });
    expect(codexSandboxFor({ trusted: true, can: ["shell", "network"] })).toEqual({ sandbox: "workspace-write", network: true });
    // Network alone doesn't open the sandbox for writing.
    expect(codexSandboxFor({ trusted: true, can: ["read", "network"] })).toEqual({ sandbox: "read-only", network: false });
    expect(taskPermissions({ runtime: "codex", trusted: true, hookInstalled: null, can: ["read", "write"] })!.args).toContain(
      "sandbox_workspace_write.network_access=false",
    );
    expect(taskPermissions({ runtime: "codex", trusted: true, hookInstalled: null, can: ["read"] })!.summary).toMatch(/may not write/);
    expect(taskPermissions({ runtime: "codex", trusted: false, hookInstalled: null, can: undefined })!.summary).toMatch(/trust the agent/);
  });

  it("leaves other agents to their catalog", () => {
    expect(taskPermissions({ runtime: "hermes", trusted: true, hookInstalled: null, can: undefined })).toBeNull();
  });
});

describe("Claude Code hook detection and role workspaces", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-task-perms-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sees Foreman's hook in Claude Code's settings, and says unknown when they can't be read", () => {
    const settings = join(dir, "settings.json");
    expect(claudeHookInstalled([settings])).toBe(false);
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    expect(claudeHookInstalled([settings])).toBe(false);
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/x/foreman hook claude-code", managed_by: FOREMAN_HOOK_MARKER }] }] },
      }),
    );
    expect(claudeHookInstalled([settings])).toBe(true);
    writeFileSync(settings, "{ not json");
    expect(claudeHookInstalled([settings])).toBeNull();
  });

  it("gives each role its own owner-only folder, under FOREMAN_WORK_DIR when set", () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const a = roleWorkspace("backend-developer", {}, home);
    expect(a).toBe(join(home, "foreman-work", "backend-developer"));
    expect(statSync(a).mode & 0o777).toBe(0o700);
    expect(roleWorkspace("backend-developer", {}, home)).toBe(a);
    expect(roleWorkspace("manager", { FOREMAN_WORK_DIR: join(dir, "w") }, home)).toBe(join(dir, "w", "manager"));
  });
});
