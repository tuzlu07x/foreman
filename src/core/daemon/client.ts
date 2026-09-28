import { randomBytes } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { readTokenFile } from "../token-file-safety.js";
import {
  daemonDisabled,
  daemonFiles,
  daemonProof,
  daemonSupported,
  DAEMON_PROTOCOL_VERSION,
  LineReader,
  MAX_HANDSHAKE_LINE,
  MAX_SOCKET_PATH,
  NONCE_RE,
  parseObjectLine,
  proofMatches,
} from "./protocol.js";

// =============================================================================
// Connecting to the Foreman daemon (#616)
// =============================================================================
//
// Used by `foreman-hook` and `foreman mcp-stdio` before they start any
// work. Anything short of a daemon that proves it holds this boot's token
// is "absent", and the caller runs the in-process path it always had: a
// missing, stale or untrusted daemon can cost speed, never a decision.
//
// This module is loaded by the fast hook on every tool call, so it imports
// nothing beyond Node's built-ins and two small Foreman helpers.

export type DaemonAuth = Record<string, unknown> & { role: "hook" | "mcp" };

export interface DaemonLink {
  socket: Socket;
  reader: LineReader;
  /** The daemon's "ok" message. */
  ok: Record<string, unknown>;
  /** Lines that arrived right after "ok". */
  pending: string[];
  /** The socket already closed (it is paused until the caller resumes it;
   *  check this after attaching a "close" listener). */
  isClosed(): boolean;
}

export type DaemonConnectResult =
  | { kind: "connected"; link: DaemonLink }
  /** No usable daemon. `notable`: something is there but isn't trusted,
   *  worth a line on stderr. */
  | { kind: "absent"; reason: string; notable: boolean }
  /** The daemon proved itself and then refused this client. */
  | { kind: "refused"; reason: string };

export interface ConnectOptions {
  stateDir: string;
  auth: DaemonAuth;
  /** For the whole handshake. Default 3 s. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** Is there a daemon socket and token this user can trust? The socket
 *  must be a socket (not a symlink) owned by this user and closed to
 *  everyone else, in a directory only this user can write to; the token
 *  file must be a 0600 regular file owned by this user (no symlink). */
export function trustedDaemonFiles(
  stateDir: string,
): { ok: true; socketPath: string; token: string } | { ok: false; reason: string; notable: boolean } {
  const { socketPath, tokenPath } = daemonFiles(stateDir);
  if (socketPath.length > MAX_SOCKET_PATH) {
    return { ok: false, reason: "the state directory path is too long for a Unix socket", notable: false };
  }
  const uid = process.getuid?.();
  let sock;
  try {
    sock = lstatSync(socketPath);
  } catch {
    return { ok: false, reason: "no daemon is running", notable: false };
  }
  if (!sock.isSocket()) {
    return { ok: false, reason: `${socketPath} is not a socket`, notable: true };
  }
  if (uid !== undefined && sock.uid !== uid) {
    return { ok: false, reason: `${socketPath} belongs to another user`, notable: true };
  }
  if ((sock.mode & 0o077) !== 0) {
    return { ok: false, reason: `${socketPath} is open to other users`, notable: true };
  }
  try {
    const dir = statSync(dirname(socketPath));
    if ((uid !== undefined && dir.uid !== uid) || (dir.mode & 0o022) !== 0) {
      return {
        ok: false,
        reason: `${dirname(socketPath)} is writable by other users (or not yours)`,
        notable: true,
      };
    }
  } catch {
    return { ok: false, reason: "the state directory can't be read", notable: false };
  }
  let token: string;
  try {
    token = readTokenFile(tokenPath, { private: true }).trim();
  } catch (err) {
    return {
      ok: false,
      reason: `the daemon token file isn't usable (${err instanceof Error ? err.message : String(err)})`,
      notable: true,
    };
  }
  if (!TOKEN_RE.test(token)) {
    return { ok: false, reason: "the daemon token file is malformed", notable: true };
  }
  return { ok: true, socketPath, token };
}

/** Connect and authenticate. Never throws. */
export function connectDaemon(opts: ConnectOptions): Promise<DaemonConnectResult> {
  const env = opts.env ?? process.env;
  if (!daemonSupported(opts.platform) || daemonDisabled(env)) {
    return Promise.resolve({ kind: "absent", reason: "the daemon is disabled here", notable: false });
  }
  const files = trustedDaemonFiles(opts.stateDir);
  if (!files.ok) return Promise.resolve({ kind: "absent", reason: files.reason, notable: files.notable });
  const { token } = files;

  return new Promise((resolve) => {
    const nonce = randomBytes(32).toString("hex");
    const reader = new LineReader(MAX_HANDSHAKE_LINE);
    let stage: "challenge" | "answer" | "done" = "challenge";
    const socket = createConnection({ path: files.socketPath });
    socket.setEncoding("utf8");

    const finish = (result: DaemonConnectResult): void => {
      if (stage === "done") return;
      stage = "done";
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (result.kind !== "connected") socket.destroy();
      resolve(result);
    };
    const absent = (reason: string, notable = false): void => finish({ kind: "absent", reason, notable });
    const timer = setTimeout(() => absent("the daemon did not answer in time"), opts.timeoutMs ?? 3_000);

    const onData = (chunk: string): void => {
      const lines = reader.push(chunk);
      if (lines === "overflow") return absent("the daemon sent an oversized handshake", true);
      for (let i = 0; i < lines.length && stage !== "done"; i++) {
        const msg = parseObjectLine(lines[i]!);
        if (!msg) return absent("the daemon sent a malformed handshake", true);
        if (stage === "challenge") {
          if (msg.t !== "challenge" || typeof msg.nonce !== "string" || !NONCE_RE.test(msg.nonce)) {
            return absent("the daemon sent a malformed challenge", true);
          }
          // The daemon proves it holds this boot's token before we send
          // anything: a stale or foreign socket gets no credential.
          if (!proofMatches(token, "daemon", nonce, msg.proof)) {
            return absent("the daemon could not prove it belongs to this Foreman boot", true);
          }
          stage = "answer";
          socket.write(
            `${JSON.stringify({ ...opts.auth, t: "auth", proof: daemonProof(token, "client", msg.nonce) })}\n`,
          );
          continue;
        }
        if (msg.t === "ok") {
          // Paused, with an error listener, until the caller takes over:
          // nothing is lost and a reset can't crash the process.
          socket.pause();
          let closed = false;
          socket.on("error", () => undefined);
          socket.once("close", () => {
            closed = true;
          });
          return finish({
            kind: "connected",
            link: { socket, reader, ok: msg, pending: lines.slice(i + 1), isClosed: () => closed },
          });
        }
        if (msg.t === "refused") {
          return finish({ kind: "refused", reason: typeof msg.reason === "string" ? msg.reason : "refused" });
        }
        return absent("the daemon sent an unexpected answer", true);
      }
    };
    const onError = (): void => absent("no daemon is listening (stale socket)");
    const onClose = (): void => absent("the daemon closed the connection during the handshake");
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ t: "hello", v: DAEMON_PROTOCOL_VERSION, nonce })}\n`);
    });
  });
}
