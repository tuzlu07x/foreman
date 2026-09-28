import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { Command } from "commander";
import { ulid } from "ulid";
import type { DbApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { resolveAgentIdentity } from "../core/agent-token.js";
import {
  daemonFiles,
  daemonProof,
  daemonSupported,
  DAEMON_PROTOCOL_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  LineReader,
  LOG_METHOD,
  MAX_HANDSHAKE_LINE,
  MAX_HOOK_LINE,
  MAX_SOCKET_PATH,
  NONCE_RE,
  parseObjectLine,
  proofMatches,
} from "../core/daemon/protocol.js";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { foremanSelfOf } from "../core/foreman-mcp-trust.js";
import { HubRuntime, SharedHub } from "../core/mcp-hub/runtime.js";
import { SecretStore } from "../core/secret-store.js";
import { createTokenFile, readTokenFile } from "../core/token-file-safety.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { encodeMessage } from "../mcp/framing.js";
import type { JSONRPCMessage } from "../mcp/types.js";
import { getForemanPaths, type ForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";
import { evaluateHookPayload } from "./hook-cli.js";
import { MAX_PAYLOAD_BYTES } from "./hook-client.js";
import {
  announceIdentity,
  bootServices,
  HUB_WATCH_MS,
  invalidSourceReason,
  McpSession,
  syncHub,
  TOOLS_LIST_CHANGED,
  type ServiceBase,
} from "./mcp-stdio.js";

// =============================================================================
// The Foreman daemon (#616)
// =============================================================================
//
// Hosted by `foreman start` (or `foreman daemon` without the TUI). It
// listens on a Unix socket in the state directory — 0600, never TCP — and
// serves two kinds of client:
//
//   - `foreman-hook`: one PreToolUse payload, decided by the same code the
//     hook runs in-process (evaluateHookPayload), answered with the exit
//     code. No start-up cost per tool call.
//   - `foreman mcp-stdio`: a whole MCP session, served by the same
//     McpSession an in-process `foreman mcp-stdio` uses, on one hub shared
//     by every agent (each upstream server runs once).
//
// Authentication has two layers. The per-boot token (a 0600 file next to
// the socket) only proves "a Foreman client of this user"; it grants
// nothing on its own. Which agent is calling is proven exactly as without
// the daemon: an MCP client passes its agent token and --source, and the
// daemon resolves them with resolveAgentIdentity, re-checked before every
// message. A hook runs as the agent id it is installed for, as in-process.
//
// Every message is bounded and parsed defensively; a client that sends
// garbage is disconnected, never trusted.

/** More simultaneous connections than any real setup has; the rest are
 *  dropped before the handshake. */
const MAX_CONNECTIONS = 256;
const MAX_TIMEOUT_MS = 7 * 24 * 3600 * 1000;
const MAX_CONTEXT_STRING = 64 * 1024;

export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export interface HubDaemonOptions {
  paths: Pick<ForemanPaths, "stateDir" | "policyPath" | "mcpConfigPath" | "mcpPinsPath" | "orgConfigPath">;
  /** Daemon-level events (a refused client, a broken mcp.yaml). */
  log: (message: string) => void;
}

export interface HubDaemon {
  socketPath: string;
  /** The hub every agent shares (tests). */
  hub: SharedHub;
  close(): Promise<void>;
}

interface Conn {
  socket: Socket;
  /** Stops whatever the connection is doing (a session, a hook). */
  teardown: () => Promise<void>;
  /** Set by endConn: the one run of teardown. */
  ended?: Promise<void>;
  /** A hook still waiting for its answer: tell it Foreman is shutting
   *  down (and the call is blocked) before the connection is dropped. */
  onShutdown?: () => void;
}

/** Run a connection's teardown once, however many times it is asked for
 *  (the socket's close event and the daemon's close both do), and never
 *  let it fail unhandled: a second run after `foreman start` closed the
 *  database threw from a close handler and took the process down. */
function endConn(conn: Conn, log: (message: string) => void): Promise<void> {
  conn.ended ??= conn.teardown().catch((err: unknown) => {
    log(`closing a daemon connection failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return conn.ended;
}

/** Start the daemon. Throws DaemonUnavailableError when it can't (Windows,
 *  a state directory others can write to, another daemon on this home). */
export async function startHubDaemon(opts: HubDaemonOptions): Promise<HubDaemon> {
  if (!daemonSupported()) {
    throw new DaemonUnavailableError("the daemon needs Unix sockets; on Windows agents keep their own process");
  }
  const { socketPath, tokenPath } = daemonFiles(opts.paths.stateDir);
  if (socketPath.length > MAX_SOCKET_PATH) {
    throw new DaemonUnavailableError(`the state directory path is too long for a Unix socket (${socketPath})`);
  }
  checkStateDir(opts.paths.stateDir);
  if (await socketAnswers(socketPath)) {
    throw new DaemonUnavailableError(`another Foreman daemon is already listening on ${socketPath}`);
  }
  removeStale(socketPath);
  removeStale(tokenPath);

  // What every session shares. The bus is private, as a separate
  // `foreman mcp-stdio` process's would be: the TUI learns about these
  // approvals through the database (ApprovalBridge), exactly once.
  const db = getDb();
  const masterKey = loadOrCreateSecretsMasterKey();
  const secretStore = new SecretStore(db, masterKey);
  const bus = new EventBus<ForemanEventMap>();
  const audit = new AuditLogger(db, bus);
  const base: ServiceBase = { db, bus, audit, masterKey, secretStore };

  const token = randomBytes(32).toString("base64url");
  createTokenFile(tokenPath, `${token}\n`);
  const hub = new SharedHub({
    paths: { mcpConfigPath: opts.paths.mcpConfigPath, mcpPinsPath: opts.paths.mcpPinsPath },
    secretStore,
    onError: opts.log,
  });
  hub.sync();

  const conns = new Set<Conn>();
  // allowHalfOpen: an agent that closes stdin still gets the answers to
  // the calls it already made, as with an in-process `foreman mcp-stdio`.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    if (conns.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const conn: Conn = { socket, teardown: async () => undefined };
    conns.add(conn);
    socket.on("close", () => {
      conns.delete(conn);
      void endConn(conn, opts.log);
    });
    serveConnection(conn, { token, base, hub, paths: opts.paths, log: opts.log });
  });
  server.on("error", (err) => opts.log(`daemon socket error: ${err.message}`));
  await new Promise<void>((resolve, reject) => {
    // Owner-only from the moment the socket file exists.
    const umask = process.umask(0o177);
    try {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(umask);
    }
  }).catch((err: unknown) => {
    removeOwnToken(tokenPath, token);
    audit.dispose();
    throw new DaemonUnavailableError(`could not listen on ${socketPath}: ${err instanceof Error ? err.message : String(err)}`);
  });
  chmodSync(socketPath, 0o600);
  const socketIno = lstatSync(socketPath).ino;

  let closed = false;
  return {
    socketPath,
    hub,
    close: async () => {
      if (closed) return;
      closed = true;
      server.close();
      // Clients see the connection drop: a hook blocks (exit 2), an MCP
      // session errors its unanswered calls. Pending approvals are
      // cancelled, never left to be allowed later.
      const all = [...conns];
      // A hook waiting on a decision hears why its call is blocked, rather
      // than "the daemon went away" (#691); the socket gets a moment to
      // flush that line before it is dropped.
      let told = false;
      for (const conn of all) {
        if (conn.onShutdown) {
          conn.onShutdown();
          told = true;
        }
      }
      if (told) await new Promise((resolve) => setTimeout(resolve, 100));
      for (const conn of all) conn.socket.destroy();
      await Promise.allSettled(all.map((c) => endConn(c, opts.log)));
      await hub.close().catch(() => undefined);
      audit.dispose();
      removeOwnToken(tokenPath, token);
      try {
        if (lstatSync(socketPath).ino === socketIno) unlinkSync(socketPath);
      } catch {
        // already gone
      }
    },
  };
}

interface ServeContext {
  token: string;
  base: ServiceBase;
  hub: SharedHub;
  paths: HubDaemonOptions["paths"];
  log: (message: string) => void;
}

function serveConnection(conn: Conn, ctx: ServeContext): void {
  const { socket } = conn;
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  const reader = new LineReader(MAX_HANDSHAKE_LINE);
  let stage: "hello" | "auth" | "hook" | "busy" = "hello";
  let serverNonce = "";
  let onLine: ((line: string) => void) | null = null;
  // After an MCP session starts, raw frames go straight to it.
  const mcp: { feed: ((chunk: string) => void) | null } = { feed: null };
  const sessionFeed = (): ((chunk: string) => void) | null => mcp.feed;
  const refuse = (reason: string): void => {
    stage = "busy";
    refuseAndClose(socket, reason);
  };
  const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
  timer.unref();

  const handshake = (line: string): void => {
    const msg = parseObjectLine(line);
    if (!msg) return void socket.destroy();
    if (stage === "hello") {
      if (msg.t !== "hello" || msg.v !== DAEMON_PROTOCOL_VERSION || typeof msg.nonce !== "string" || !NONCE_RE.test(msg.nonce)) {
        return void socket.destroy();
      }
      serverNonce = randomBytes(32).toString("hex");
      stage = "auth";
      socket.write(
        `${JSON.stringify({ t: "challenge", proof: daemonProof(ctx.token, "daemon", msg.nonce), nonce: serverNonce })}\n`,
      );
      return;
    }
    if (stage === "auth") {
      if (msg.t !== "auth" || !proofMatches(ctx.token, "client", serverNonce, msg.proof)) {
        ctx.log("refused a connection to the daemon socket without this boot's token");
        return refuse("bad token");
      }
      clearTimeout(timer);
      if (msg.role === "hook") {
        stage = "hook";
        reader.setMaxLine(MAX_HOOK_LINE);
        // The request follows at once; a client that stalls is dropped.
        const wait = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
        wait.unref();
        onLine = (requestLine) => {
          clearTimeout(wait);
          stage = "busy";
          onLine = null;
          serveHook(conn, requestLine, ctx);
        };
        socket.write(`${JSON.stringify({ t: "ok" })}\n`);
        return;
      }
      if (msg.role === "mcp") {
        stage = "busy";
        return serveMcp(conn, msg, ctx, (feed) => {
          onLine = null;
          mcp.feed = feed;
        });
      }
      return refuse("unknown role");
    }
  };

  // Only an MCP session may half-close (the agent closed stdin); anything
  // else that does is dropped.
  socket.on("end", () => {
    if (!mcp.feed) socket.destroy();
  });
  socket.on("data", (chunk: string) => {
    if (mcp.feed) return mcp.feed(chunk);
    if (stage === "busy" && !onLine) return;
    const lines = reader.push(chunk);
    if (lines === "overflow") return void socket.destroy();
    for (const line of lines) {
      // (read through a call: a line above may have started the session)
      const feed = sessionFeed();
      if (feed) feed(`${line}\n`);
      else if (onLine) onLine(line);
      else if (stage === "hello" || stage === "auth") handshake(line);
      else return; // nothing else is expected
    }
    const feed = sessionFeed();
    const rest = reader.rest();
    if (feed && rest) feed(rest);
  });
}

function serveHook(conn: Conn, line: string, ctx: ServeContext): void {
  const { socket } = conn;
  const answer = (exit: 0 | 2, lines: Array<{ level: "info" | "error"; text: string }>): void => {
    socket.end(`${JSON.stringify({ t: "result", exit, lines })}\n`);
  };
  const req = parseHookRequest(line);
  if (typeof req === "string") return answer(2, [{ level: "error", text: `invalid hook request (${req}) — blocking the call.` }]);

  const requestId = ulid();
  let approval: DbApprovalService | null = null;
  let answered = false;
  let gone = false;
  let shuttingDown = false;
  conn.onShutdown = () => {
    if (answered || shuttingDown || socket.destroyed) return;
    shuttingDown = true;
    answer(2, [{ level: "error", text: "Foreman is shutting down — blocking the call. Review with `foreman log tail`." }]);
  };
  // The hook process went away (Claude Code's timeout, a kill): its
  // approval can never be answered, so it is cancelled (denied), or never
  // opened when the call hasn't got that far.
  conn.teardown = async () => {
    gone = true;
    if (answered || !approval) return;
    approval.close();
    approval.cancelPending([requestId]);
  };
  void evaluateHookPayload(req.payload, req.agentId, {
    open: () => ({ db: ctx.base.db, bus: ctx.base.bus, flushAudit: () => ctx.base.audit.flush() }),
    policyPath: ctx.paths.policyPath,
    mcpConfigPath: ctx.paths.mcpConfigPath,
    timeoutMs: req.timeoutMs,
    process: {
      cwd: req.ctx.cwd,
      home: req.ctx.home,
      env: {
        PATH: req.ctx.path,
        ...(req.ctx.claudeConfigDir ? { CLAUDE_CONFIG_DIR: req.ctx.claudeConfigDir } : {}),
      },
      self: foremanSelfOf({ argv1: req.ctx.argv1 ?? undefined, execPath: req.ctx.execPath, path: req.ctx.path }),
    },
    requestId,
    onApproval: (a) => {
      approval = a;
      if (gone) a.close();
    },
  }).then((verdict) => {
    answered = true;
    // Already told it Foreman is shutting down: that answer stands.
    if (!socket.destroyed && !shuttingDown) answer(verdict.exit, verdict.lines);
  });
}

interface HookRequest {
  agentId: string;
  timeoutMs: number;
  payload: string;
  ctx: {
    cwd: string;
    home: string;
    path: string;
    claudeConfigDir: string | null;
    argv1: string | null;
    execPath: string;
  };
}

/** A hook request, or why it is refused. */
export function parseHookRequest(line: string): HookRequest | string {
  const msg = parseObjectLine(line);
  if (!msg || msg.t !== "hook") return "not a hook request";
  const { agentId, timeoutMs, payload, ctx } = msg;
  if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 256) return "agent id";
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return "timeout";
  }
  if (typeof payload !== "string" || payload.length > MAX_PAYLOAD_BYTES) return "payload";
  if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) return "context";
  const c = ctx as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_CONTEXT_STRING;
  const absolute = (v: unknown): v is string => str(v) && isAbsolute(v);
  const optional = (v: unknown): v is string | null => v === null || v === undefined || str(v);
  if (!absolute(c.cwd) || !absolute(c.home) || !str(c.path) || !absolute(c.execPath)) return "context";
  if (!optional(c.claudeConfigDir) || !optional(c.argv1)) return "context";
  return {
    agentId,
    timeoutMs,
    payload,
    ctx: {
      cwd: c.cwd,
      home: c.home,
      path: c.path,
      claudeConfigDir: (c.claudeConfigDir as string | null | undefined) ?? null,
      argv1: (c.argv1 as string | null | undefined) ?? null,
      execPath: c.execPath,
    },
  };
}

function serveMcp(
  conn: Conn,
  auth: Record<string, unknown>,
  ctx: ServeContext,
  takeOver: (feed: (chunk: string) => void) => void,
): void {
  const { socket } = conn;
  const refuse = (reason: string): void => refuseAndClose(socket, reason);
  const source = auth.source;
  if (source !== null && source !== undefined && typeof source !== "string") return refuse("invalid --source");
  const sourceProblem = invalidSourceReason(source ?? undefined);
  if (sourceProblem) return refuse(sourceProblem);
  const agentToken = auth.agentToken;
  if (agentToken !== null && agentToken !== undefined && (typeof agentToken !== "string" || agentToken.length > 1024)) {
    return refuse("invalid agent token");
  }
  const timeout = auth.approvalTimeoutMs;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_MS) {
    return refuse("invalid approval timeout");
  }

  const write = (frame: string): void => {
    if (!socket.destroyed && socket.writable) socket.write(frame);
  };
  const warn = (message: string): void =>
    write(encodeMessage({ jsonrpc: "2.0", method: LOG_METHOD, params: { message } } as JSONRPCMessage));

  let services;
  try {
    services = bootServices({ base: ctx.base, approvalTimeoutMs: timeout, warn });
  } catch (err) {
    // A policy.yaml that doesn't load: the client falls back and reports
    // it the same way an in-process start would.
    return refuse(err instanceof Error ? err.message : String(err));
  }
  const token = typeof agentToken === "string" ? agentToken.trim() : "";
  // The agent is proven here, from its own token, exactly as in-process:
  // the daemon's token says nothing about which agent this is.
  const identity = resolveAgentIdentity({
    claimed: typeof source === "string" ? services.registry.canonicalId(source) : undefined,
    token: token || undefined,
    store: services.secretStore,
    isRegistered: (id) => services.registry.get(id) !== null,
  });
  // A new session: pins are re-read and listings re-verified, as they
  // would be in a freshly started process.
  ctx.hub.beginSession();
  services.hubRuntime = new HubRuntime({
    paths: {
      mcpConfigPath: ctx.paths.mcpConfigPath,
      mcpPinsPath: ctx.paths.mcpPinsPath,
      orgConfigPath: ctx.paths.orgConfigPath,
    },
    secretStore: services.secretStore,
    agentId: identity.source,
    onError: warn,
    onToolsChanged: () => {
      if (services.clientInitialized) write(encodeMessage(TOOLS_LIST_CHANGED));
    },
    shared: ctx.hub,
  });
  syncHub(services);
  const session = new McpSession(services, identity, token, { write, warn });
  const hubWatch = setInterval(() => syncHub(services), HUB_WATCH_MS);
  hubWatch.unref();
  conn.teardown = async () => {
    clearInterval(hubWatch);
    await session.drain();
  };
  socket.write(`${JSON.stringify({ t: "ok", source: identity.source, trusted: identity.trusted })}\n`);
  announceIdentity(services, identity);
  // The agent closed its end: cancel what waits on a human, give running
  // calls their grace period, then close.
  socket.on("end", () => {
    void session.drain().finally(() => socket.end());
  });
  takeOver((chunk) => session.feed(chunk));
}

function refuseAndClose(socket: Socket, reason: string): void {
  socket.end(`${JSON.stringify({ t: "refused", reason: reason.slice(0, 500) })}\n`);
  setTimeout(() => socket.destroy(), 1_000).unref();
}

function checkStateDir(dir: string): void {
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new DaemonUnavailableError(`the state directory ${dir} is missing`);
  }
  const uid = process.getuid?.();
  if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
    throw new DaemonUnavailableError(
      `${dir} is writable by other users (or not yours), so a socket there can't be trusted; chmod go-w it to use the daemon`,
    );
  }
}

/** Is a live daemon behind this path? */
function socketAnswers(path: string): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = createConnection({ path });
    const done = (live: boolean): void => {
      clearTimeout(timer);
      probe.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), 500);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/** Remove what a previous daemon left (a socket, its token file). Never
 *  follows a symlink: unlink removes the link itself. Anything that isn't
 *  ours is refused rather than removed. */
function removeStale(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new DaemonUnavailableError(`${path} belongs to another user; remove it to use the daemon`);
  }
  if (st.isDirectory()) throw new DaemonUnavailableError(`${path} is a directory`);
  unlinkSync(path);
}

function removeOwnToken(path: string, token: string): void {
  try {
    // Read through one no-follow descriptor (an owned regular file only),
    // so what is compared is what was checked: no check-then-read race.
    if (readTokenFile(path, { private: true }).trim() === token) unlinkSync(path);
  } catch {
    // already gone, or not ours to remove
  }
}

export const daemonCommand = new Command("daemon")
  .description(
    "Run Foreman's local daemon without the TUI: agents' `foreman mcp-stdio` and the PreToolUse hook connect to it " +
      "(one copy of each MCP hub server, no start-up cost per hook call). `foreman start` runs it too.",
  )
  .action(async () => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
      process.stderr.write(red("error: ") + `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.\n`);
      process.exit(1);
    }
    let daemon: HubDaemon;
    try {
      daemon = await startHubDaemon({
        paths,
        log: (message) => process.stderr.write(`foreman daemon: ${message}\n`),
      });
    } catch (err) {
      process.stderr.write(red("error: ") + `${err instanceof Error ? err.message : String(err)}\n`);
      closeDb();
      process.exit(1);
    }
    process.stderr.write(`foreman daemon: listening on ${daemon.socketPath}\n`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await daemon.close();
    closeDb();
    process.exit(0);
  });
