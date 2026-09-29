import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseHookRequest } from "../../../src/cli/hub-daemon.js";
import { fastHookArgs } from "../../../src/cli/hook-client.js";
import { connectDaemon, trustedDaemonFiles } from "../../../src/core/daemon/client.js";
import {
  daemonDisabled,
  daemonFiles,
  daemonProof,
  daemonSupported,
  LineReader,
  proofMatches,
} from "../../../src/core/daemon/protocol.js";

// The daemon's wire protocol (#616): bounded framing, the token proofs,
// request validation, and the client's refusal to trust what it can't
// verify.

const TOKEN = "t".repeat(43);

describe("LineReader", () => {
  it("splits lines across chunks and keeps the rest", () => {
    const r = new LineReader(100);
    expect(r.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(r.push(":2}\n")).toEqual(['{"b":2}']);
    expect(r.rest()).toBe("");
  });

  it("refuses a line longer than the limit, with or without its newline", () => {
    expect(new LineReader(10).push(`${"x".repeat(11)}\n`)).toBe("overflow");
    expect(new LineReader(10).push("x".repeat(11))).toBe("overflow");
    expect(new LineReader(10).push(`short\n${"y".repeat(20)}\n`)).toBe("overflow");
  });
});

describe("token proofs", () => {
  it("only the matching token, role and nonce prove anything", () => {
    const nonce = "ab".repeat(32);
    const proof = daemonProof(TOKEN, "client", nonce);
    expect(proofMatches(TOKEN, "client", nonce, proof)).toBe(true);
    expect(proofMatches("u".repeat(43), "client", nonce, proof)).toBe(false);
    expect(proofMatches(TOKEN, "client", "cd".repeat(32), proof)).toBe(false);
    // The daemon's own proof can't be reflected back as the client's.
    expect(proofMatches(TOKEN, "client", nonce, daemonProof(TOKEN, "daemon", nonce))).toBe(false);
    for (const junk of [undefined, 42, "", "zz", proof.toUpperCase(), `${proof}00`]) {
      expect(proofMatches(TOKEN, "client", nonce, junk)).toBe(false);
    }
  });
});

describe("where the daemon runs", () => {
  it("never on Windows, and not when FOREMAN_NO_DAEMON is set", () => {
    expect(daemonSupported("win32")).toBe(false);
    expect(daemonSupported("linux")).toBe(true);
    expect(daemonDisabled({ FOREMAN_NO_DAEMON: "1" })).toBe(true);
    expect(daemonDisabled({ FOREMAN_NO_DAEMON: "0" })).toBe(false);
    expect(daemonDisabled({})).toBe(false);
  });
});

describe("parseHookRequest", () => {
  const ctx = {
    cwd: "/work",
    home: "/home/me",
    path: "/usr/bin",
    claudeConfigDir: null,
    argv1: "/opt/foreman/dist/cli/hook.js",
    execPath: "/usr/bin/node",
  };
  const line = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ t: "hook", agentId: "claude-code", timeoutMs: 1000, payload: "{}", ctx, ...over });

  it("accepts a well-formed request", () => {
    expect(parseHookRequest(line())).toMatchObject({ agentId: "claude-code", timeoutMs: 1000, payload: "{}" });
  });

  it("carries the launch's FOREMAN_SPAWNED_BY, or null", () => {
    expect(parseHookRequest(line())).toMatchObject({ ctx: { spawnedBy: null } });
    expect(parseHookRequest(line({ ctx: { ...ctx, spawnedBy: "reviewer" } }))).toMatchObject({ ctx: { spawnedBy: "reviewer" } });
    expect(typeof parseHookRequest(line({ ctx: { ...ctx, spawnedBy: 7 } }))).toBe("string");
  });

  it("refuses anything malformed, oversized or out of range", () => {
    const bad = [
      "not json",
      "[]",
      line({ t: "mcp" }),
      line({ agentId: "" }),
      line({ agentId: "a".repeat(257) }),
      line({ agentId: 7 }),
      line({ timeoutMs: -1 }),
      line({ timeoutMs: 1.5 }),
      line({ timeoutMs: 8 * 24 * 3600 * 1000 }),
      line({ timeoutMs: "1000" }),
      line({ payload: { tool_name: "Bash" } }),
      line({ payload: "x".repeat(4 * 1024 * 1024 + 1) }),
      line({ ctx: null }),
      line({ ctx: { ...ctx, cwd: "relative/dir" } }),
      line({ ctx: { ...ctx, home: undefined } }),
      line({ ctx: { ...ctx, execPath: 3 } }),
      line({ ctx: { ...ctx, argv1: "x".repeat(70_000) } }),
    ];
    for (const l of bad) expect(typeof parseHookRequest(l)).toBe("string");
  });
});

describe("fastHookArgs", () => {
  it("takes the installed shape and leaves everything else to the full command", () => {
    expect(fastHookArgs(["claude-code"])).toEqual({ agentId: "claude-code", timeoutFlag: undefined });
    expect(fastHookArgs(["claude-code", "--timeout-ms", "200"])).toEqual({ agentId: "claude-code", timeoutFlag: 200 });
    expect(fastHookArgs(["--timeout-ms=5", "claude-code"])).toEqual({ agentId: "claude-code", timeoutFlag: 5 });
    for (const argv of [
      [],
      ["--help"],
      ["claude-code", "--bogus"],
      ["claude-code", "codex"],
      ["claude-code", "--timeout-ms"],
      ["claude-code", "--timeout-ms", "-1"],
      ["claude-code", "--timeout-ms", "1e3"],
      ["claude-code", "--timeout-ms", "1", "--timeout-ms", "2"],
    ]) {
      expect(fastHookArgs(argv)).toBeNull();
    }
  });
});

describe("the client's trust in a daemon", () => {
  let dir: string;
  let server: Server | null;
  let received: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fm-proto-"));
    chmodSync(dir, 0o700);
    server = null;
    received = [];
  });
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  /** A socket that answers the hello with `proveWith`'s proof. */
  const fakeDaemon = async (proveWith: string): Promise<void> => {
    const { socketPath } = daemonFiles(dir);
    server = createServer((s) => {
      s.setEncoding("utf8");
      s.on("data", (d: string) => {
        for (const line of d.split("\n").filter(Boolean)) {
          received.push(line);
          const msg = JSON.parse(line) as { t: string; nonce?: string };
          if (msg.t === "hello") {
            s.write(`${JSON.stringify({ t: "challenge", proof: daemonProof(proveWith, "daemon", msg.nonce!), nonce: "cd".repeat(32) })}\n`);
          } else if (msg.t === "auth") {
            s.write(`${JSON.stringify({ t: "ok" })}\n`);
          }
        }
      });
    });
    await new Promise<void>((r) => server!.listen(socketPath, r));
    chmodSync(socketPath, 0o600);
    writeFileSync(daemonFiles(dir).tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  };

  it("finds nothing to trust without a socket", () => {
    expect(trustedDaemonFiles(dir)).toMatchObject({ ok: false, notable: false });
  });

  it("won't use a socket path that isn't a socket, or a directory others can write to", async () => {
    writeFileSync(daemonFiles(dir).socketPath, "");
    expect(trustedDaemonFiles(dir)).toMatchObject({ ok: false, notable: true, reason: expect.stringMatching(/not a socket/) });
    rmSync(daemonFiles(dir).socketPath);
    await fakeDaemon(TOKEN);
    expect(trustedDaemonFiles(dir)).toMatchObject({ ok: true });
    chmodSync(dir, 0o770);
    expect(trustedDaemonFiles(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/writable by other users/) });
  });

  it("sends nothing but the hello to a daemon that can't prove the token", async () => {
    await fakeDaemon("w".repeat(43));
    const r = await connectDaemon({ stateDir: dir, auth: { role: "mcp", agentToken: "fat_secret" }, env: {} });
    expect(r).toMatchObject({ kind: "absent", notable: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(received.map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(["hello"]);
    expect(received.join()).not.toContain("fat_secret");
  });

  it("connects to one that can", async () => {
    await fakeDaemon(TOKEN);
    const r = await connectDaemon({ stateDir: dir, auth: { role: "hook" }, env: {} });
    expect(r.kind).toBe("connected");
    if (r.kind === "connected") r.link.socket.destroy();
    const auth = JSON.parse(received[1]!) as { t: string; proof: string; role: string };
    expect(auth).toMatchObject({ t: "auth", role: "hook" });
    expect(proofMatches(TOKEN, "client", "cd".repeat(32), auth.proof)).toBe(true);
    // The token itself never crosses the socket.
    expect(received.join()).not.toContain(TOKEN);
  });

  it("doesn't even look when the daemon is off", async () => {
    await fakeDaemon(TOKEN);
    const r = await connectDaemon({ stateDir: dir, auth: { role: "hook" }, env: { FOREMAN_NO_DAEMON: "1" } });
    expect(r.kind).toBe("absent");
    expect(received).toEqual([]);
  });
});
