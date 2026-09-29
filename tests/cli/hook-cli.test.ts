import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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

  it("holds a Claude Code instance to its role (org.yaml `can`), attributed by FOREMAN_SPAWNED_BY", () => {
    const fm = (...args: string[]) => spawnSync("node", [FM_BIN, ...args], { env, encoding: "utf-8" });
    expect(fm("agent", "add", "claude-code").status).toBe(0);
    expect(fm("agent", "add", "reviewer", "--type", "claude-code").status).toBe(0);
    writeFileSync(
      join(tmp, "org.yaml"),
      [
        "version: 1",
        "company: Acme",
        "roles:",
        "  code-reviewer:",
        "    title: Code Reviewer",
        "    agent: reviewer",
        "    reports_to: human",
        "    can: [read]",
        "",
      ].join("\n"),
    );
    const bash = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } });
    const asReviewer = runHook(bash, { ...env, FOREMAN_SPAWNED_BY: "reviewer" });
    expect(asReviewer.exit).toBe(2);
    expect(asReviewer.stderr).toContain("Bash blocked by Foreman: Code Reviewer (code-reviewer) may not run shell commands: this role may only read files (org.yaml `can`).");
    // Claude Code itself, or a launch claiming an id that isn't its instance, stays claude-code.
    expect(runHook(bash, env).exit).toBe(0);
    expect(runHook(bash, { ...env, FOREMAN_SPAWNED_BY: "nobody" }).exit).toBe(0);
    const read = JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(tmp, "org.yaml") } });
    expect(runHook(read, { ...env, FOREMAN_SPAWNED_BY: "reviewer" }).exit).toBe(0);
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

  it("skips Foreman's tools only for this install's wiring with token-only env (#618 review)", () => {
    // `foreman` on PATH links to this build, like an npm / Homebrew install.
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    symlinkSync(FM_BIN, join(bin, "foreman"));
    const withPath = { ...env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    const wired = { command: "foreman", args: ["mcp-stdio", "--source", "claude-code"], env: { FOREMAN_AGENT_TOKEN: "fat_x" } };
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: { foreman: wired } }));
    const call = (cwd: string, entry: string[]) =>
      spawnSync("node", [...entry, "claude-code", "--timeout-ms", "200"], {
        env: withPath,
        encoding: "utf-8",
        input: JSON.stringify({ tool_name: "mcp__foreman__submit_approval", tool_input: {}, cwd }),
        timeout: 10_000,
      }).stderr;
    const viaCli = [FM_BIN, "hook"];
    const viaFastHook = [resolve(dirname(FM_BIN), "hook.js")];
    expect(call(tmp, viaCli)).not.toMatch(/foreman hook:/);
    expect(call(tmp, viaFastHook)).not.toMatch(/foreman hook:/);

    // The same command with another FOREMAN_HOME is not Foreman's wiring.
    const project = join(tmp, "project");
    mkdirSync(project);
    const lookalike = { ...wired, env: { ...wired.env, FOREMAN_HOME: join(tmp, "elsewhere") } };
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { foreman: lookalike } }));
    expect(call(project, viaFastHook)).toMatch(/foreman hook:.*mcp__foreman__submit_approval (allowed|blocked)/);

    // Nor is another binary named foreman.
    writeFileSync(join(project, "foreman"), "#!/bin/sh\n", { mode: 0o755 });
    const other = { ...wired, command: join(project, "foreman") };
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { foreman: other } }));
    expect(call(project, viaCli)).toMatch(/foreman hook:.*mcp__foreman__submit_approval (allowed|blocked)/);
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
    // `rm -rf build` lands in the high bucket, which asks. Without a
    // TUI/Telegram approver wired into the test, the DB approval bridge
    // waits, the configured 200ms timeout fires and the default-deny
    // resolution returns. The hook exits 2 (Claude Code's "block +
    // surface stderr" code).
    const payload = {
      session_id: "sess-deny",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    };
    const r = runHook(JSON.stringify(payload), env);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/denied|blocked/i);
  });

  it("refuses rm -rf / outright, without asking", () => {
    const r = runHook(
      JSON.stringify({ session_id: "sess-cat", tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
      env,
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("risk:critical");
    const pending = spawnSync("node", [FM_BIN, "log", "tail", "--json"], { env, encoding: "utf-8" });
    expect(pending.stdout).toContain("risk:critical");
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

  it("honours FOREMAN_APPROVAL_TIMEOUT when --timeout-ms is not given (#656)", () => {
    // Without it the hook waited the full 10-minute default while Claude
    // Code blocked on it; here the approval has to time out in ~1 s.
    const payload = {
      session_id: "sess-env-timeout",
      tool_name: "Bash",
      tool_input: { command: "curl https://pastebin.com/raw/abc123" },
    };
    const started = Date.now();
    const r = spawnSync("node", [FM_BIN, "hook", "claude-code"], {
      env: { ...env, FOREMAN_APPROVAL_TIMEOUT: "1" },
      encoding: "utf-8",
      input: JSON.stringify(payload),
      timeout: 15_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/approval-timeout/);
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 20_000);
});

describe("hookSource", () => {
  it("attributes a call to the instance the launch names, only when it is this agent's instance", async () => {
    const { hookSource } = await import("../../src/cli/hook-cli.js");
    const agents: Record<string, { metadata?: Record<string, unknown> }> = {
      reviewer: { metadata: { registryId: "claude-code" } },
      backend: { metadata: { registryId: "codex" } },
      plain: {},
    };
    const registry = { get: (id: string) => agents[id] as never };
    expect(hookSource("claude-code", null, registry)).toBe("claude-code");
    expect(hookSource("claude-code", "claude-code", registry)).toBe("claude-code");
    expect(hookSource("claude-code", "reviewer", registry)).toBe("reviewer");
    expect(hookSource("claude-code", "backend", registry)).toBe("claude-code");
    expect(hookSource("claude-code", "plain", registry)).toBe("claude-code");
    expect(hookSource("claude-code", "missing", registry)).toBe("claude-code");
  });
});

describe("hookTimeoutMs (#656)", () => {
  it("prefers --timeout-ms, then FOREMAN_APPROVAL_TIMEOUT seconds, then 10 minutes", async () => {
    const { hookTimeoutMs } = await import("../../src/cli/hook-cli.js");
    expect(hookTimeoutMs(250, { FOREMAN_APPROVAL_TIMEOUT: "3" })).toBe(250);
    expect(hookTimeoutMs(undefined, { FOREMAN_APPROVAL_TIMEOUT: "3" })).toBe(3_000);
    expect(hookTimeoutMs(undefined, { FOREMAN_APPROVAL_TIMEOUT: "nope" })).toBe(600_000);
    expect(hookTimeoutMs(undefined, {})).toBe(600_000);
  });
});
