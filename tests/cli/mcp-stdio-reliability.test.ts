import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startForeman } from "../../src/cli/start.js";

// #594 — "an MCP client became unreachable after a delegated-agent cycle".
// Real processes: an agent's `foreman mcp-stdio`, `foreman start`'s control
// drain spawning a delegated agent that connects back through its own
// `foreman mcp-stdio`, and other processes writing the same database.
//
// The failure it reproduces: when another process held the SQLite write
// lock past the busy timeout (5 s), the audit logger's timer flush threw
// SQLITE_BUSY as an uncaught exception. `foreman mcp-stdio` exited (code 7)
// in the middle of the session, so the agent's next request got no answer,
// and the batch it was writing (the audit row of a call that had already
// been allowed) was lost. `foreman start` died the same way, taking the
// audit row of the delegated agent's outcome with it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FM_BIN = join(ROOT, "dist/cli/index.js");
const BETTER_SQLITE = createRequire(import.meta.url).resolve("better-sqlite3");

interface Rpc {
  jsonrpc: string;
  id: number;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/** An agent speaking newline-delimited JSON-RPC to `foreman mcp-stdio`. */
class Agent {
  stderr = "";
  exitCode: number | null = null;
  readonly exited: Promise<number | null>;
  private buf = "";
  private nextId = 1;
  private readonly waiters = new Map<number, (r: Rpc) => void>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        // Anything on stdout that isn't a JSON-RPC frame fails the test here.
        const msg = JSON.parse(this.buf.slice(0, nl)) as Rpc;
        this.buf = this.buf.slice(nl + 1);
        this.waiters.get(msg.id)?.(msg);
      }
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((r) =>
      child.once("exit", (code) => {
        this.exitCode = code;
        r(code);
      }),
    );
  }

  /** Resolves with the reply, or rejects if none comes in `timeoutMs`
   *  (or the server exits first). */
  call(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<Rpc> {
    const id = this.nextId++;
    return new Promise<Rpc>((resolveCall, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${method} in ${timeoutMs} ms (exit ${this.exitCode}); stderr: ${this.stderr}`)),
        timeoutMs,
      );
      void this.exited.then(() => reject(new Error(`mcp-stdio exited (${this.exitCode}) before answering ${method}; stderr: ${this.stderr}`)));
      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        resolveCall(r);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const textOf = (r: Rpc): string => r.result?.content?.[0]?.text ?? "";

/** A 127.0.0.1 port that was free a moment ago (for the spend receiver). */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

describe("foreman mcp-stdio under concurrent database writers (#594)", () => {
  let root: string;
  let home: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;
  let token: string;
  const agents: Agent[] = [];

  const connect = (): Agent => {
    const agent = new Agent(
      spawn(process.execPath, [FM_BIN, "mcp-stdio", "--source", "orchestrator"], {
        env: { ...env, FOREMAN_AGENT_TOKEN: token },
      }),
    );
    agents.push(agent);
    return agent;
  };

  /** Read-only look at the database, as `foreman log` would. */
  const query = <T>(sql: string): T[] => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "foreman-594-"));
    home = join(root, "foreman");
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "home"));
    dbPath = join(home, "foreman.db");
    // The delegated agent: a stand-in for `claude --print "<task>"` that,
    // like the real one wired to Foreman, calls back through its own
    // `foreman mcp-stdio` before it finishes.
    const stub = join(bin, "claude");
    writeFileSync(
      stub,
      [
        `#!${process.execPath}`,
        `if (process.argv[2] === "--version") { console.log("claude 0.0.0-test"); process.exit(0); }`,
        `const { spawn } = require("node:child_process");`,
        `const mcp = spawn(process.execPath, [${JSON.stringify(FM_BIN)}, "mcp-stdio", "--source", "claude-code"]);`,
        `let buf = "";`,
        `mcp.stdout.on("data", (d) => {`,
        `  buf += d;`,
        `  if (!buf.includes('"id":2')) return;`,
        `  console.log("[stub claude] did: " + process.argv.slice(3).join(" "));`,
        `  mcp.stdin.end();`,
        `});`,
        `mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");`,
        `mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_command", arguments: { command: "status" } } }) + "\\n");`,
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    env = {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: join(root, "home"),
      TMPDIR: tmpdir(),
      FOREMAN_HOME: home,
      FOREMAN_NO_UPDATE_CHECK: "1",
      FOREMAN_NO_AGENT_UPDATE_CHECK: "1",
    };
    const run = (...args: string[]) => {
      const res = spawnSync(process.execPath, [FM_BIN, ...args], { env, encoding: "utf-8" });
      if (res.status !== 0) throw new Error(`foreman ${args.join(" ")}: ${res.stderr}`);
    };
    run("init");
    run("agent", "add", "claude-code", "--type", "claude-code", "--skip-config", "--skip-projection");
    run("agent", "add", "orchestrator", "--type", "generic-mcp", "--skip-config", "--token-out", join(root, "orchestrator.token"));
    token = readFileSync(join(root, "orchestrator.token"), "utf-8").trim();
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      if (agent.exitCode === null) await agent.close();
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps serving, and keeps the audit row, when another process holds the database past the busy timeout", async () => {
    const agent = connect();
    await agent.call("initialize");
    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      // Allowed by the default policy; its audit row is written ~100 ms
      // later by a timer, which waits out the 5 s busy timeout and fails.
      const read = await agent.call(
        "tools/call",
        { name: "read_file", arguments: { path: "/tmp/foreman-594.txt" } },
        15_000,
      );
      expect(textOf(read)).toContain("allowed");
      await waitFor(
        "the failed audit write (or the process exiting)",
        () => agent.stderr.includes("audit log write failed") || agent.exitCode !== null,
        15_000,
      );
      // Before #594 the process was gone at this point (uncaught SQLITE_BUSY, exit 7).
      expect(agent.exitCode).toBeNull();
      expect(agent.stderr).toMatch(/audit log write failed \(database is locked\); \d+ audit entr(y|ies) kept/);
    } finally {
      holder.exec("COMMIT");
      holder.close();
    }
    expect(await agent.call("ping")).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    // The kept row lands once the lock is gone.
    await waitFor(
      "the read_file audit row",
      () => query<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE args LIKE '%foreman-594.txt%'")[0]!.n === 1,
      10_000,
    );
    expect(agent.stderr).toContain("audit log writes recovered");
    expect(await agent.close()).toBe(0);
  }, 40_000);

  it("a write that loses the lock comes back as a JSON-RPC error, and the transport stays up", async () => {
    const agent = connect();
    await agent.call("initialize");
    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    let handoff: Rpc;
    const startedAt = Date.now();
    try {
      handoff = await agent.call(
        "tools/call",
        { name: "submit_command", arguments: { command: "write", args: ["claude-code", "summarise", "the", "readme"] } },
        30_000,
      );
    } finally {
      holder.exec("COMMIT");
      holder.close();
    }
    // Bounded by the busy timeout of the writes on its path, not a hang.
    expect(Date.now() - startedAt).toBeLessThan(25_000);
    expect(handoff.error?.code).toBe(-32603);
    expect(handoff.error?.message).toContain("database is locked");
    // Nothing was queued, so nothing will run behind the agent's back.
    expect(query<{ n: number }>("SELECT COUNT(*) AS n FROM control_commands")[0]!.n).toBe(0);
    expect((await agent.call("ping")).result).toEqual({});
    expect(await agent.close()).toBe(0);
  }, 40_000);

  it("answers the next request after a delegated-agent cycle, with other processes writing meanwhile", async () => {
    // Another process writing audit rows in short transactions for the
    // whole cycle, on top of `foreman start` and the delegated agent's own
    // `foreman mcp-stdio`.
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const D = require(${JSON.stringify(BETTER_SQLITE)});
         const db = new D(${JSON.stringify(dbPath)}, { timeout: 5000 });
         const insert = db.prepare("INSERT INTO audit_events (event_type, payload, created_at) VALUES ('test:writer', '{}', ?)");
         const tick = () => {
           db.exec("BEGIN IMMEDIATE");
           insert.run(Date.now());
           const until = Date.now() + 20;
           while (Date.now() < until) {}
           db.exec("COMMIT");
           setTimeout(tick, 10);
         };
         tick();`,
      ],
      { stdio: "ignore" },
    );
    // `foreman start` without its TUI: the control drain that spawns the
    // delegated agent. In this process (the command wants a terminal).
    const saved = { ...process.env };
    Object.assign(process.env, env, { FOREMAN_OTLP_PORT: String(await freePort()) });
    const started = startForeman({ withTui: false });
    try {
      const agent = connect();
      await agent.call("initialize");
      const handoff = await agent.call("tools/call", {
        name: "submit_command",
        arguments: { command: "write", args: ["claude-code", "summarise", "the", "readme"] },
      });
      expect(textOf(handoff)).toContain("Spawning claude-code");
      const done = await waitFor(
        "the delegated agent's outcome",
        () =>
          query<{ payload: string }>(
            "SELECT payload FROM audit_events WHERE event_type = 'control_write_outcome'",
          )[0],
        15_000,
      );
      const outcome = JSON.parse(done.payload) as { spawnKind: string; stdoutTail: string };
      expect(outcome.spawnKind).toBe("ok");
      expect(outcome.stdoutTail).toContain("[stub claude] did: summarise the readme");
      expect(query<{ status: string }>("SELECT status FROM control_commands")).toEqual([{ status: "applied" }]);
      // The delegated agent's own MCP session was mediated and audited.
      expect(
        query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'foreman:command' AND payload LIKE '%untrusted:claude-code%'",
        )[0]!.n,
      ).toBe(1);

      // The request after the cycle.
      expect((await agent.call("ping")).result).toEqual({});
      const status = await agent.call("tools/call", { name: "submit_command", arguments: { command: "status" } });
      expect(status.result?.isError).toBe(false);
      expect(textOf(status)).toContain("claude-code");
      expect(await agent.close()).toBe(0);
      // On a loaded machine the writer can keep the lock past the busy
      // timeout; that is the case #594 fixed. A failed write must then be
      // followed by its recovery (a clean exit above means nothing was
      // left unwritten).
      if (agent.stderr.includes("audit log write failed")) {
        expect(agent.stderr).toContain("audit log writes recovered");
      }
    } finally {
      writer.kill();
      await started.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }, 40_000);
});
