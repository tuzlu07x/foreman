import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonProof } from "../../src/core/daemon/protocol.js";

// =============================================================================
// The daemon (#616), end to end: `foreman daemon` hosts it, `foreman-hook`
// and `foreman mcp-stdio` are its clients. What must hold:
//   - decisions are the same as in-process;
//   - a daemon that dies mid-call blocks the hook (exit 2) and errors the
//     MCP call, never re-running it;
//   - a client without the boot token is refused, and a client never
//     trusts a socket (or token) it can't verify: it runs in-process;
//   - agents keep their own identity and scope;
//   - each upstream server starts once for all agents.
// =============================================================================

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FM_BIN = join(ROOT, "dist/cli/index.js");
const HOOK_BIN = join(ROOT, "dist/cli/hook.js");
const DEMO = join(ROOT, "tests/core/mcp-hub/fixtures/demo-server.mjs");

interface Rpc {
  id: number;
  method?: string;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

class Session {
  private buf = "";
  private waiters = new Map<number, (r: Rpc) => void>();
  stderr = "";
  readonly notifications: string[] = [];
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });
    child.stdout.on("data", (d: Buffer) => {
      this.buf += d.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const msg = JSON.parse(this.buf.slice(0, nl)) as Rpc;
        this.buf = this.buf.slice(nl + 1);
        if (msg.id !== undefined) this.waiters.get(msg.id)?.(msg);
        else if (msg.method) this.notifications.push(msg.method);
      }
    });
  }
  call(id: number, method: string, params: unknown = {}): Promise<Rpc> {
    const done = new Promise<Rpc>((r) => this.waiters.set(id, r));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return done;
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null) await new Promise((r) => this.child.on("exit", r));
  }
}

const until = async (check: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("the Foreman daemon (#616)", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let daemon: ChildProcess | null;
  let daemonStderr: string;
  const sock = () => join(home, "foreman.sock");
  const tokenFile = () => join(home, "foreman.sock.token");
  const starts = () => join(home, "upstream-starts.log");

  const startDaemon = async (): Promise<void> => {
    daemonStderr = "";
    const child = spawn("node", [FM_BIN, "daemon"], { env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (d: Buffer) => {
      daemonStderr += d.toString();
    });
    daemon = child;
    await until(() => daemonStderr.includes("listening on") || child.exitCode !== null);
    expect(child.exitCode).toBeNull();
  };
  const killDaemon = async (signal: NodeJS.Signals = "SIGKILL"): Promise<void> => {
    const child = daemon;
    daemon = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.on("exit", r));
    child.kill(signal);
    await exited;
  };

  const hook = (
    agent: string,
    payload: unknown,
    extra: { env?: NodeJS.ProcessEnv; args?: string[] } = {},
  ): Promise<{ exit: number | null; stderr: string }> =>
    new Promise((done) => {
      const child = spawn("node", [HOOK_BIN, agent, ...(extra.args ?? ["--timeout-ms", "300"])], {
        env: { ...env, ...extra.env },
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("exit", (exit) => done({ exit, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
  const bash = (command: string, session = "s") => ({
    session_id: session,
    tool_name: "Bash",
    tool_input: { command },
  });

  const tokenFor = (id: string): string => {
    const file = join(home, `${id}.token`);
    spawnSync(
      "node",
      [FM_BIN, "agent", "add", id, "--type", "generic-mcp", "--skip-config", "--token-out", file],
      { env: { ...env, FOREMAN_NO_DAEMON: "1" }, encoding: "utf-8" },
    );
    return readFileSync(file, "utf-8").trim();
  };
  const mcp = (source: string, token: string | null, extraEnv: NodeJS.ProcessEnv = {}) =>
    new Session(
      spawn("node", [FM_BIN, "mcp-stdio", "--source", source], {
        env: { ...env, ...(token ? { FOREMAN_AGENT_TOKEN: token } : {}), ...extraEnv },
      }),
    );
  const pendingApprovals = (): number => {
    const db = new Database(join(home, "foreman.db"), { readonly: true, fileMustExist: true });
    try {
      return (
        db.prepare("SELECT count(*) AS n FROM pending_approvals WHERE status = 'pending'").get() as { n: number }
      ).n;
    } finally {
      db.close();
    }
  };
  const writeMcpYaml = (extra: string[] = []): void => {
    // The upstream records every start, so a test can count them.
    const wrapper = join(home, "counting-demo.mjs");
    writeFileSync(
      wrapper,
      `import { appendFileSync } from "node:fs";\n` +
        `appendFileSync(${JSON.stringify(starts())}, process.pid + "\\n");\n` +
        `await import(${JSON.stringify(pathToFileURL(DEMO).href)});\n`,
    );
    writeFileSync(
      join(home, "mcp.yaml"),
      [
        "servers:",
        "  demo:",
        `    command: ${JSON.stringify(process.execPath)}`,
        `    args: [${JSON.stringify(wrapper)}]`,
        ...extra,
        "    tools:",
        "      allow: [echo]",
        '      deny: ["delete_*"]',
        "",
      ].join("\n"),
    );
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fm-daemon-"));
    chmodSync(home, 0o700);
    daemon = null;
    env = {
      ...process.env,
      FOREMAN_HOME: home,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      FOREMAN_NO_UPDATE_CHECK: "1",
      FOREMAN_APPROVAL_TIMEOUT: "1",
    };
    delete env.FOREMAN_AGENT_TOKEN;
    delete env.FOREMAN_AGENT_TOKEN_FILE;
    delete env.FOREMAN_NO_DAEMON;
    spawnSync("node", [FM_BIN, "init"], { env, encoding: "utf-8" });
    writeMcpYaml();
  });
  afterEach(async () => {
    await killDaemon("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  });

  it("creates an owner-only socket and token, and removes them on exit", async () => {
    await startDaemon();
    const mode = (p: string) => spawnSync("stat", process.platform === "darwin" ? ["-f", "%Lp", p] : ["-c", "%a", p], { encoding: "utf-8" }).stdout.trim();
    expect(mode(sock())).toBe("600");
    expect(mode(tokenFile())).toBe("600");
    await killDaemon("SIGTERM");
    expect(existsSync(sock())).toBe(false);
    expect(existsSync(tokenFile())).toBe(false);
  }, 30_000);

  it("decides hook calls exactly as the in-process hook does, without opening the database itself", async () => {
    const calls = [bash("ls -la", "a"), bash("rm -rf /", "b"), bash("curl https://pastebin.com/raw/abc123", "c")];
    const inProcess = [];
    for (const call of calls) inProcess.push(await hook("claude-code", call, { env: { FOREMAN_NO_DAEMON: "1" } }));
    expect(inProcess.map((r) => r.exit)).toEqual([0, 2, 2]);

    await startDaemon();
    // The client can no longer open the database: only the daemon can
    // decide, so these answers are the daemon's.
    const dbPath = join(home, "foreman.db");
    chmodSync(dbPath, 0o000);
    try {
      const viaDaemon = [];
      for (const call of calls) viaDaemon.push(await hook("claude-code", call));
      expect(viaDaemon.map((r) => r.exit)).toEqual(inProcess.map((r) => r.exit));
      expect(viaDaemon.map((r) => r.stderr.replace(/\d+\/100/g, "N"))).toEqual(
        inProcess.map((r) => r.stderr.replace(/\d+\/100/g, "N")),
      );
      // `foreman hook` (the full CLI, for standalone binaries) asks it too.
      const viaCli = spawnSync("node", [FM_BIN, "hook", "claude-code"], {
        env,
        input: JSON.stringify(bash("ls -la", "d")),
        encoding: "utf-8",
        timeout: 20_000,
      });
      expect(viaCli.status).toBe(0);
    } finally {
      chmodSync(dbPath, 0o600);
    }
    // Both sets are in the audit log with the same decisions.
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT decision, decided_by AS decidedBy FROM requests WHERE source_agent = 'claude-code' ORDER BY created_at")
      .all() as Array<{ decision: string; decidedBy: string }>;
    db.close();
    expect(rows).toHaveLength(7);
    expect(rows.slice(3, 6)).toEqual(rows.slice(0, 3));
    expect(rows[6]).toEqual(rows[0]);
  }, 60_000);

  it("blocks the call (exit 2) when the daemon dies while the call waits for approval", async () => {
    await startDaemon();
    const running = hook("claude-code", bash("rm -rf /"), { args: ["--timeout-ms", "60000"] });
    await until(() => pendingApprovals() > 0);
    await killDaemon("SIGKILL");
    const r = await running;
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/Foreman daemon went away before deciding — blocking the call/);
  }, 60_000);

  it("cancels (denies) a hook's pending approval when the hook process goes away", async () => {
    await startDaemon();
    const child = spawn("node", [HOOK_BIN, "claude-code", "--timeout-ms", "60000"], { env });
    child.stdin.end(JSON.stringify(bash("rm -rf /")));
    await until(() => pendingApprovals() > 0);
    child.kill("SIGKILL");
    await until(() => pendingApprovals() === 0);
    const db = new Database(join(home, "foreman.db"), { readonly: true });
    const row = db.prepare("SELECT decision, resolved_by AS resolvedBy FROM pending_approvals").get() as {
      decision: string;
      resolvedBy: string;
    };
    db.close();
    expect(row).toEqual({ decision: "denied", resolvedBy: "cancelled" });
  }, 60_000);

  it("errors an MCP call the daemon dies during, never re-runs it, and serves the session in-process after", async () => {
    writeFileSync(
      join(home, "mcp.yaml"),
      readFileSync(join(home, "mcp.yaml"), "utf-8").replace("      allow: [echo]", "      allow: [echo]\n      confirm: [echo]"),
    );
    const token = tokenFor("claude-code");
    await startDaemon();
    const s = mcp("claude-code", token, { FOREMAN_APPROVAL_TIMEOUT: "60" });
    await s.call(1, "initialize");
    const pending = s.call(2, "tools/call", { name: "demo__echo", arguments: { text: "merge it" } });
    await until(() => pendingApprovals() > 0);
    await killDaemon("SIGKILL");
    const answer = await pending;
    expect(answer.result).toBeUndefined();
    expect(answer.error?.message).toMatch(/daemon stopped before answering this call/);
    expect(answer.error?.message).toMatch(/not retried/);
    // The session goes on, served by this process.
    const list = await s.call(3, "tools/list");
    expect(list.result!.tools!.map((t) => t.name)).toContain("demo__echo");
    expect(s.stderr).toMatch(/serving this session in this process/);
    await s.close();
  }, 60_000);

  it("refuses a client that can't prove it holds this boot's token", async () => {
    await startDaemon();
    const reply = await new Promise<string>((done) => {
      const c = createConnection({ path: sock() });
      c.setEncoding("utf8");
      let buf = "";
      c.on("data", (d: string) => {
        buf += d;
        const lines = buf.split("\n");
        if (lines.length > 1 && buf.includes('"challenge"') && !buf.includes('"auth"')) {
          const challenge = JSON.parse(lines[0]!) as { nonce: string };
          // A proof made with the wrong token.
          c.write(`${JSON.stringify({ t: "auth", role: "hook", proof: daemonProof("x".repeat(43), "client", challenge.nonce) })}\n`);
          buf = "";
        }
      });
      c.on("close", () => done(buf));
      c.write(`${JSON.stringify({ t: "hello", v: 1, nonce: "ab".repeat(32) })}\n`);
    });
    expect(JSON.parse(reply.trim())).toEqual({ t: "refused", reason: "bad token" });
    // Garbage, and an oversized line, are dropped without harming the daemon.
    for (const junk of ["not json\n", `${"x".repeat(200_000)}`]) {
      await new Promise<void>((done) => {
        const c = createConnection({ path: sock() });
        c.on("error", () => undefined);
        c.on("close", () => done());
        c.write(junk);
      });
    }
    const ok = await hook("claude-code", bash("ls"));
    expect(ok.exit).toBe(0);
    expect(ok.stderr).not.toMatch(/not using the Foreman daemon/);
  }, 60_000);

  it("never trusts a daemon that can't prove the token, a socket open to others, or a symlink: it decides in-process", async () => {
    await startDaemon();
    // Stale token: the file no longer matches the daemon.
    const original = readFileSync(tokenFile(), "utf-8");
    writeFileSync(tokenFile(), `${"Z".repeat(43)}\n`, { mode: 0o600 });
    let r = await hook("claude-code", bash("ls"));
    expect(r.exit).toBe(0);
    expect(r.stderr).toMatch(/not using the Foreman daemon: the daemon could not prove it belongs to this Foreman boot/);
    writeFileSync(tokenFile(), original, { mode: 0o600 });

    chmodSync(tokenFile(), 0o644);
    r = await hook("claude-code", bash("ls"));
    expect(r.stderr).toMatch(/not using the Foreman daemon: the daemon token file isn't usable/);
    chmodSync(tokenFile(), 0o600);

    chmodSync(sock(), 0o666);
    r = await hook("claude-code", bash("ls"));
    expect(r.exit).toBe(0);
    expect(r.stderr).toMatch(/not using the Foreman daemon: .* is open to other users/);
    chmodSync(sock(), 0o600);

    const real = join(home, "real.sock");
    renameSync(sock(), real);
    symlinkSync(real, sock());
    r = await hook("claude-code", bash("ls"));
    expect(r.exit).toBe(0);
    expect(r.stderr).toMatch(/not using the Foreman daemon: .* is not a socket/);
    unlinkSync(sock());
    renameSync(real, sock());

    // A malicious "daemon" answering allow is out of reach: without the
    // token it can't answer the challenge. A dead socket is just absent.
    await killDaemon("SIGKILL");
    r = await hook("claude-code", bash("rm -rf /"));
    expect(r.exit).toBe(2); // decided in-process: denied, as always
  }, 60_000);

  it("won't start in a state directory other users can write to", async () => {
    chmodSync(home, 0o770);
    try {
      const r = spawnSync("node", [FM_BIN, "daemon"], { env, encoding: "utf-8", timeout: 20_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/writable by other users/);
    } finally {
      chmodSync(home, 0o700);
    }
  }, 30_000);

  it("has an agent's calls in the audit trail by the time its mcp-stdio exits", async () => {
    // An in-process mcp-stdio flushed its audit queue on exit. Through the
    // daemon the queue lives in \`foreman start\`, so an agent that had
    // just gone could still have its last call unwritten for a moment
    // (QA scenario 09 on Linux read the audit trail right then).
    const claude = tokenFor("claude-code");
    await startDaemon();
    const s = mcp("claude-code", claude);
    await s.call(1, "initialize");
    const call = await s.call(2, "tools/call", { name: "demo__echo", arguments: { text: "audit-me" } });
    expect(call.result!.content![0]!.text).toBe("audit-me");
    await s.close();
    expect(s.stderr).not.toMatch(/not using the Foreman daemon/);
    const db = new Database(join(home, "foreman.db"), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT count(*) AS n FROM requests WHERE args LIKE '%audit-me%'").get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  }, 60_000);

  it("keeps each agent to its own identity and scope", async () => {
    writeFileSync(
      join(home, "mcp.yaml"),
      readFileSync(join(home, "mcp.yaml"), "utf-8").replace("    tools:", "    access: { agents: [codex] }\n    tools:"),
    );
    const claude = tokenFor("claude-code");
    const codex = tokenFor("codex");
    await startDaemon();
    const hubTools = async (source: string, token: string | null) => {
      const s = mcp(source, token);
      await s.call(1, "initialize");
      const names = (await s.call(2, "tools/list")).result!.tools!.map((t) => t.name);
      const call = await s.call(3, "tools/call", { name: "demo__echo", arguments: { text: "hi" } });
      await s.close();
      expect(s.stderr).not.toMatch(/not using the Foreman daemon/);
      return { names, call };
    };
    const asCodex = await hubTools("codex", codex);
    expect(asCodex.names).toContain("demo__echo");
    expect(asCodex.call.result!.content![0]!.text).toBe("hi");

    const asClaude = await hubTools("claude-code", claude);
    expect(asClaude.names).not.toContain("demo__echo");
    expect(asClaude.call.result!.isError).toBe(true);
    expect(asClaude.call.result!.content![0]!.text).toMatch(/don't have access to the 'demo' MCP server/);

    // Claiming codex with claude-code's token, or with none, proves nothing.
    for (const token of [claude, null]) {
      const borrowed = await hubTools("codex", token);
      expect(borrowed.names).not.toContain("demo__echo");
      expect(JSON.stringify(borrowed.call)).not.toContain('"text":"hi"');
    }
  }, 90_000);

  it("applies confirm rules, hub-only secrets and live reload through the daemon", async () => {
    expect(
      spawnSync("node", [FM_BIN, "secrets", "add", "demo-token", "--value", "hunter2hunter2"], {
        env: { ...env, FOREMAN_NO_DAEMON: "1" },
        encoding: "utf-8",
      }).status,
    ).toBe(0);
    writeMcpYaml([
      "    env:",
      "      DEMO_TOKEN: ${secret:demo-token}",
      // Managed as an integration: its credential is for the hub only.
      '    integration: { id: github, variant: official, access_level: read-only, created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" }',
    ]);
    writeFileSync(
      join(home, "mcp.yaml"),
      readFileSync(join(home, "mcp.yaml"), "utf-8").replace("      allow: [echo]", "      allow: [echo]\n      confirm: [echo]"),
    );
    const token = tokenFor("claude-code");
    await startDaemon();
    const s = mcp("claude-code", token);
    await s.call(1, "initialize");
    // The integration's credential is for the hub only, whatever policy says.
    const secret = await s.call(2, "tools/call", { name: "secrets/get", arguments: { name: "demo-token" } });
    expect(secret.error?.message).toBe("Denied by reserved:integration");
    // A confirm tool waits for a person; nobody answers within 1 s.
    const confirm = await s.call(3, "tools/call", { name: "demo__echo", arguments: { text: "merge it" } });
    expect(confirm.error?.message).toContain("Denied by approval-timeout");
    // Disabling the server reaches the connected agent.
    expect(spawnSync("node", [FM_BIN, "mcp", "disable", "demo"], { env, encoding: "utf-8" }).status).toBe(0);
    await until(() => s.notifications.includes("notifications/tools/list_changed"), 8_000);
    expect((await s.call(4, "tools/list")).result!.tools!.map((t) => t.name)).not.toContain("demo__echo");
    expect(s.stderr).not.toMatch(/not using the Foreman daemon|serving this session in this process/);
    await s.close();
  }, 60_000);

  it("starts each upstream server once for every agent", async () => {
    const claude = tokenFor("claude-code");
    const codex = tokenFor("codex");
    const echoFrom = async (source: string, token: string, extraEnv: NodeJS.ProcessEnv = {}) => {
      const s = mcp(source, token, extraEnv);
      await s.call(1, "initialize");
      const out = await s.call(2, "tools/call", { name: "demo__echo", arguments: { text: source } });
      expect(out.result!.content![0]!.text).toBe(source);
      return s;
    };
    const countStarts = () => (existsSync(starts()) ? readFileSync(starts(), "utf-8").trim().split("\n").length : 0);

    // In-process: each agent's own copy.
    const a = await echoFrom("claude-code", claude, { FOREMAN_NO_DAEMON: "1" });
    const b = await echoFrom("codex", codex, { FOREMAN_NO_DAEMON: "1" });
    expect(countStarts()).toBe(2);
    await Promise.all([a.close(), b.close()]);
    rmSync(starts());

    await startDaemon();
    const c = await echoFrom("claude-code", claude);
    const d = await echoFrom("codex", codex);
    const e = await echoFrom("claude-code", claude);
    expect(countStarts()).toBe(1);
    await Promise.all([c.close(), d.close(), e.close()]);
  }, 90_000);
});
