import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultHookCommand, FOREMAN_HOOK_MARKER } from "../../src/core/agent-hook.js";
import { checkClaudeHook } from "../../src/core/doctor.js";

// `foreman doctor` flags a Claude Code hook that fails open (a bare command
// from PATH, 2.2.0) or blocks everything (its pinned program is gone) (#714).
describe("doctor: claude_hook", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fm-dch-"));
    mkdirSync(join(home, ".claude"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const withHook = (command: string): void => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, managed_by: FOREMAN_HOOK_MARKER }] }] } }),
    );
  };

  it("is fine without settings or without a Foreman hook", () => {
    expect(checkClaudeHook({}, home)).toMatchObject({ status: "ok", message: "no Claude Code settings" });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "my-linter" }] }] } }));
    expect(checkClaudeHook({}, home)).toMatchObject({ status: "ok", message: expect.stringContaining("not installed") });
  });

  it("warns about a hook that runs foreman-hook from PATH", () => {
    withHook("foreman-hook claude-code");
    const r = checkClaudeHook({}, home);
    expect(r.status).toBe("warn");
    expect(r.message).toContain("run unguarded");
    expect(r.remediation).toContain("foreman agent hook install claude-code");
  });

  it("is ok when pinned to programs that exist, and fails when one is gone", () => {
    const node = join(home, "node dir", "node");
    const hook = join(home, "hook.js");
    mkdirSync(join(home, "node dir"));
    writeFileSync(node, "");
    writeFileSync(hook, "");
    withHook(defaultHookCommand("claude-code", { argv: [node, hook] }, "darwin"));
    expect(checkClaudeHook({}, home)).toMatchObject({ status: "ok", message: expect.stringContaining("pinned to this Foreman") });

    rmSync(hook);
    const r = checkClaudeHook({}, home);
    expect(r.status).toBe("fail");
    expect(r.message).toBe(`${hook} no longer exists — every Claude Code tool call is blocked`);
  });

  it("reads CLAUDE_CONFIG_DIR when set", () => {
    const other = join(home, "cc");
    mkdirSync(other);
    writeFileSync(join(other, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "foreman hook claude-code", managed_by: FOREMAN_HOOK_MARKER }] }] } }));
    expect(checkClaudeHook({ CLAUDE_CONFIG_DIR: other }, home).status).toBe("warn");
  });
});
