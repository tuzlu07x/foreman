import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// =============================================================================
// #517 Faz 4 — `foreman hook claude-code` script. Subprocess tests so the
// stdin/exit-code contract Claude Code's PreToolUse runner depends on is
// exercised end-to-end. Test harness opens a fresh foreman home + DB so
// runs don't bleed into each other (or into the operator's real install).
// =============================================================================

const FM_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  "dist/cli/index.js",
);

interface RunResult {
  stdout: string;
  stderr: string;
  exit: number;
}

function runHook(stdinPayload: string, env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(
    "node",
    [FM_BIN, "hook", "claude-code", "--timeout-ms", "200"],
    {
      env,
      encoding: "utf-8",
      input: stdinPayload,
      timeout: 10_000,
    },
  );
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exit: result.status ?? -1,
  };
}

describe("foreman hook claude-code — Faz 4 (#517)", () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-hook-cli-"));
    env = {
      ...process.env,
      FOREMAN_HOME: tmp,
      // The hook reads ~/.claude.json to trust Foreman's own MCP server (#619).
      HOME: tmp,
      CLAUDE_CONFIG_DIR: "",
      // Initialise DB on the fly so the hook script's DbApprovalService
      // has a `pending_approvals` table to insert into.
      FOREMAN_AUTO_MIGRATE: "1",
    };
    // Initialise the foreman home so getDb() doesn't error.
    spawnSync("node", [FM_BIN, "init"], { env, encoding: "utf-8" });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Claude Code runs the tool on any exit code other than 2, so every
  // failure path must block (fail closed).
  it("exits 2 with no stdin payload (fail closed)", () => {
    const r = runHook("", env);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/empty PreToolUse payload/);
  });

  it("exits 2 on a usage error (missing agent id, unknown flag)", () => {
    for (const args of [["hook"], ["hook", "claude-code", "--bogus"]]) {
      const r = spawnSync("node", [FM_BIN, ...args], { env, encoding: "utf-8", timeout: 10_000 });
      expect(r.status).toBe(2);
    }
  });

  it("exits 2 when an async error escapes, even through the main CLI's handler", async () => {
    // Throw once the hook is waiting on stdin — after the main CLI's
    // rethrowing uncaughtException handler is installed.
    const preload = join(tmp, "throw-later.mjs");
    writeFileSync(
      preload,
      `const t = setInterval(() => {
        if (process.stdin.listenerCount("data") > 0) {
          clearInterval(t);
          setImmediate(() => { throw new Error("boom"); });
        }
      }, 10);\n`,
    );
    // stdin stays open, so the hook is parked in readStdin when it throws.
    const child = spawn("node", ["--import", preload, FM_BIN, "hook", "claude-code"], { env });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const status = await new Promise<number | null>((done) => child.on("exit", done));
    clearTimeout(killer);
    const r = { stderr, status };
    expect(r.stderr).toContain("boom");
    expect(r.status).toBe(2);
  });

  it("exits 2 on malformed JSON payload (fail closed)", () => {
    const r = runHook("{ not json", env);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/could not parse/i);
  });

  it("exits 2 when the payload has no tool_name (fail closed)", () => {
    const r = runHook(JSON.stringify({ session_id: "abc" }), env);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/tool_name/);
  });

  it("exits 2 when the Foreman database cannot be opened (fail closed)", () => {
    // FOREMAN_HOME under a regular file: every DB open fails. Before the
    // fail-closed rewrite this surfaced as exit 1/7, which Claude Code
    // treats as a non-blocking error and runs the tool anyway.
    const blocker = join(tmp, "not-a-dir");
    writeFileSync(blocker, "x");
    const r = runHook(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      { ...env, FOREMAN_HOME: join(blocker, "home") },
    );
    expect(r.exit).toBe(2);
  });

  it("writes an audit row for an allowed call (policy + audit apply to hooks)", () => {
    const r = runHook(
      JSON.stringify({
        session_id: "sess-audit",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
      env,
    );
    expect(r.exit).toBe(0);
    const log = spawnSync("node", [FM_BIN, "log", "tail", "--json"], {
      env,
      encoding: "utf-8",
    });
    expect(log.stdout).toContain("shell_exec");
  });

  it("applies policy.yaml deny rules to Claude Code tool calls", () => {
    writeFileSync(
      join(tmp, "policy.yaml"),
      [
        "rules:",
        '  - source: "claude-code"',
        '    target: "tool:shell_exec"',
        "    effect: deny",
        "",
      ].join("\n"),
    );
    const r = runHook(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" } }),
      env,
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/policy:/);
  });

  it("asks before Read touches an SSH private key", () => {
    const r = runHook(
      JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/home/u/.ssh/id_rsa" },
      }),
      env,
    );
    expect(r.exit).toBe(2);
  });

  it("the lightweight foreman-hook entry honours the same contract", () => {
    const fast = spawnSync(
      "node",
      [resolve(dirname(FM_BIN), "hook.js"), "claude-code", "--timeout-ms", "200"],
      {
        env,
        encoding: "utf-8",
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
        timeout: 10_000,
      },
    );
    expect(fast.status).toBe(2);
    const bad = spawnSync("node", [resolve(dirname(FM_BIN), "hook.js"), "claude-code"], {
      env,
      encoding: "utf-8",
      input: "{ nope",
      timeout: 10_000,
    });
    expect(bad.status).toBe(2);
  });

  it("lets Foreman's own MCP tools through (mediated inside mcp-stdio)", () => {
    const r = runHook(
      JSON.stringify({ tool_name: "mcp__foreman__secrets/get", tool_input: {}, cwd: tmp }),
      env,
    );
    expect(r.exit).toBe(0);
    // Skipped: the mediator never saw it, so there is no decision line.
    expect(r.stderr).not.toMatch(/foreman hook:/);
  });

  it("gates a tool Foreman doesn't serve, even under the foreman name (#619)", () => {
    const r = runHook(
      JSON.stringify({ tool_name: "mcp__foreman__run_shell", tool_input: { command: "ls" }, cwd: tmp }),
      env,
    );
    expect(r.stderr).toMatch(/foreman hook:.*mcp__foreman__run_shell (allowed|blocked)/);
  });

  it("gates Foreman's tool names when a project .mcp.json swaps in another foreman server (#619)", () => {
    const project = join(tmp, "project");
    mkdirSync(project);
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { foreman: { command: "node", args: ["./not-foreman.js"] } } }),
    );
    const r = runHook(
      JSON.stringify({ tool_name: "mcp__foreman__submit_approval", tool_input: {}, cwd: project }),
      env,
    );
    expect(r.stderr).toMatch(/foreman hook:.*mcp__foreman__submit_approval (allowed|blocked)/);
  });

  it("exits 0 on a low-risk tool call (no user prompt)", () => {
    // `ls -la` is a read-only inspection — risk score is well under the
    // `ask` threshold so the hook auto-allows without going through the
    // DB approval bridge.
    const payload = {
      session_id: "sess-low",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    };
    const r = runHook(JSON.stringify(payload), env);
    expect(r.exit).toBe(0);
    expect(r.stderr).toMatch(/allowed/);
  });

  it("exits 2 on a high-risk shell-destructive command after the user-default-deny timeout", () => {
    // `rm -rf /` trips shell-pattern rules + lands in the `ask` bucket
    // (RiskScorer's default recommendation table maps high → ask, not
    // deny). Without a TUI/Telegram approver wired into the test, the
    // DB approval bridge waits + the configured 200ms timeout fires +
    // the default-deny resolution returns. The hook exits 2 (Claude
    // Code's "block + surface stderr" code).
    const payload = {
      session_id: "sess-deny",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    };
    const r = runHook(JSON.stringify(payload), env);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/denied|blocked/i);
  });

  it("times out + denies a borderline call when no approver is reachable", () => {
    // `curl pastebin.com` lands in the `ask` bucket — without a TUI/Telegram
    // approver wired into the test, the DB approval bridge waits + the
    // default-deny timeout fires after the 200ms we configured above.
    const payload = {
      session_id: "sess-ask",
      tool_name: "Bash",
      tool_input: { command: "curl https://pastebin.com/raw/abc123" },
    };
    const r = runHook(JSON.stringify(payload), env);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/denied|blocked/i);
  });
});
