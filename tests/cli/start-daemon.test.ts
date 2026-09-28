import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { startForeman } from "../../src/cli/start.js";

// `foreman start` hosts the daemon (#616): the hook uses it while Foreman
// runs, and falls back to its own process once Foreman has stopped.

const HOOK_BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "dist/cli/hook.js");

describe("foreman start hosts the daemon", () => {
  let home: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fm-start-daemon-"));
    saved = { ...process.env };
    process.env.FOREMAN_HOME = home;
    process.env.FOREMAN_NO_UPDATE_CHECK = "1";
    process.env.FOREMAN_NO_AGENT_UPDATE_CHECK = "1";
    delete process.env.FOREMAN_NO_DAEMON;
  });
  afterEach(() => {
    process.env = saved;
    rmSync(home, { recursive: true, force: true });
  });

  // Async: the daemon answers from this very process.
  const hook = (
    command = "ls",
    timeoutMs = 300,
  ): Promise<{ exit: number | null; stderr: string }> =>
    new Promise((done) => {
      const child = spawn("node", [HOOK_BIN, "claude-code", "--timeout-ms", String(timeoutMs)], {
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "" },
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("exit", (exit) => done({ exit, stderr }));
      child.stdin.end(JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command } }));
    });

  it("listens while Foreman runs and cleans up on shutdown", async () => {
    runInit();
    const started = startForeman({ withTui: false });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(home, "foreman.sock")) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(join(home, "foreman.sock"))).toBe(true);
      const r = await hook();
      expect(r.exit).toBe(0);
      expect(r.stderr).toMatch(/allowed/);
    } finally {
      await started.shutdown();
    }
    expect(existsSync(join(home, "foreman.sock"))).toBe(false);
    expect(existsSync(join(home, "foreman.sock.token"))).toBe(false);
    // Without Foreman running, the hook decides on its own again.
    const after = await hook();
    expect(after.exit).toBe(0);
  }, 60_000);

  it("quits cleanly while a hook call waits for approval, and blocks that call", async () => {
    // QA 2026-09-28: quitting the TUI with a hook approval open threw from
    // the daemon's socket close handler (the connection's teardown ran a
    // second time, after the database was closed) and start exited 7.
    runInit();
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);
    const started = startForeman({ withTui: false });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(home, "foreman.sock")) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // High risk: waits on a human for up to a minute.
      const waiting = hook("rm -rf ./build", 60_000);
      // Let the approval open before quitting.
      await new Promise((r) => setTimeout(r, 2_000));
      await started.shutdown();
      const r = await waiting;
      expect(r.exit).toBe(2);
      // The socket's own close event runs after shutdown returned.
      await new Promise((r) => setTimeout(r, 200));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 60_000);
});
