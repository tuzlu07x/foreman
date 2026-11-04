import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// =============================================================================
// `foreman write <agent> <message>` — CLI surface for the chat verb.
// QA round 15 regression: an agent's LLM that shells out
// `foreman write claude-code "..."` previously got
// `error: unknown command 'write'`. The CLI now enqueues the same
// control_commands row the chat path uses.
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

function runFm(args: string[], env: NodeJS.ProcessEnv): RunResult {
  try {
    const stdout = execFileSync("node", [FM_BIN, ...args], {
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exit: 0 };
  } catch (err) {
    const e = err as {
      status: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      exit: e.status,
    };
  }
}

describe("foreman write — CLI", () => {
  let tmpHome: string;
  let fakeHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-write-"));
    fakeHome = mkdtempSync(join(tmpdir(), "foreman-write-h-"));
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome };
    runFm(["init"], env);
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("rejects with usage hint when called with no agent", () => {
    const r = runFm(["write"], env);
    expect(r.exit).not.toBe(0);
    // Commander prints its own missing-argument error before we run.
    expect(r.stderr).toMatch(/missing required argument|agent/);
  });

  it("returns exit 2 on an unknown agent id with a 'foreman agents list' hint", () => {
    const r = runFm(["write", "ghost-agent", "hello"], env);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("ghost-agent");
    expect(r.stderr).toContain("foreman agents list");
  });

  it("enqueues a control_commands row + prints tracking id on success", () => {
    // Add a stub agent so the registry lookup passes. `foreman agents
    // add` is the host-CLI surface for inserting rows.
    const add = runFm(
      [
        "agents",
        "add",
        "codex",
        "--type",
        "codex",
        "--skip-config",
        "--skip-projection",
      ],
      env,
    );
    expect(add.exit).toBe(0);

    const r = runFm(["write", "codex", "review", "the", "PR"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("codex");
    expect(r.stdout).toMatch(/tracking id=\d+/);
    expect(r.stdout).toMatch(/foreman start/);
  });

  it("warns when `foreman start` is not running (drain handler missing)", () => {
    runFm(
      [
        "agents",
        "add",
        "codex",
        "--type",
        "codex",
        "--skip-config",
        "--skip-projection",
      ],
      env,
    );
    // The test FOREMAN_HOME is fresh per test → no foreman.pid file →
    // readForemanPid returns null → warning path fires.
    const r = runFm(["write", "codex", "hello"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/foreman start.*not running/);
    // The tracking-id line still prints — the row IS enqueued, the
    // warning just tells the user nothing will pick it up yet.
    expect(r.stdout).toMatch(/tracking id=\d+/);
  });

  it("refuses an agent handing work to itself, and queues nothing", () => {
    const add = runFm(["agent", "add", "codex", "--skip-config"], env);
    expect(add.exit).toBe(0);
    const res = runFm(["write", "CODEX", "again"], { ...env, FOREMAN_SPAWNED_BY: "codex" });
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain("can't hand work to itself");
    const db = new Database(join(tmpHome, "foreman.db"), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_commands").get()).toEqual({ n: 0 });
    db.close();
    // The person at the keyboard can still write to any agent.
    expect(runFm(["write", "codex", "by hand"], env).exit).toBe(0);
  });

  it("the runaway guard holds here too: not only on the chat path", () => {
    expect(runFm(["agent", "add", "codex", "--skip-config"], env).exit).toBe(0);
    expect(runFm(["agent", "add", "hermes", "--skip-config"], env).exit).toBe(0);
    const db = new Database(join(tmpHome, "foreman.db"));
    const insert = db.prepare(
      "INSERT INTO delegations (id, initiator_agent, target_agent, prompt_summary, started_at, status) VALUES (?, 'hermes', 'codex', 'x', ?, 'open')",
    );
    for (let i = 0; i < 5; i++) insert.run(`d${i}`, Date.now());
    db.close();
    const res = runFm(["write", "codex", "again"], { ...env, FOREMAN_SPAWNED_BY: "hermes" });
    expect(res.exit).toBe(2);
    expect(res.stderr).toContain("Runaway-loop guard blocked");
  });

  it("lower-cases the agent id token (case-insensitive lookup)", () => {
    runFm(
      [
        "agents",
        "add",
        "codex",
        "--type",
        "codex",
        "--skip-config",
        "--skip-projection",
      ],
      env,
    );
    const r = runFm(["write", "CODEX", "hi"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/tracking id=\d+/);
  });
});
