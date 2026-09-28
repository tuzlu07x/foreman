import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

// =============================================================================
// The Foreman daemon's local protocol (#616)
// =============================================================================
//
// `foreman start` listens on a Unix socket in the state directory (0600,
// never TCP). `foreman mcp-stdio` and `foreman-hook` connect to it instead
// of booting the mediation stack and their own copy of every hub server.
//
// Newline-delimited JSON, like MCP stdio. The handshake:
//
//   client → {"t":"hello","v":1,"nonce":<hex>}
//   daemon → {"t":"challenge","proof":HMAC(token,"daemon",nonce),"nonce":<hex>}
//   client → {"t":"auth","proof":HMAC(token,"client",nonce'),"role":…,…}
//   daemon → {"t":"ok",…} or {"t":"refused","reason":…}
//
// The token is a random value written to a 0600 file when the daemon boots.
// It never crosses the socket: each side proves it knows it. The client
// checks the daemon's proof before it sends anything that matters (an agent
// token, a hook payload), so a stale or foreign socket gets nothing. The
// token only proves "a local Foreman client of this user"; which agent is
// calling is proven separately, exactly as without the daemon.
//
// After "ok": a hook client sends one {"t":"hook",…} line and reads one
// {"t":"result",…} line. An MCP client relays JSON-RPC frames both ways;
// the daemon's diagnostics for the agent's stderr arrive as the private
// notification LOG_METHOD, which the client never passes to the agent.

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_SOCKET_FILE = "foreman.sock";
export const DAEMON_TOKEN_FILE = "foreman.sock.token";
/** Set to 1 to never use the daemon (always the in-process path). */
export const NO_DAEMON_ENV = "FOREMAN_NO_DAEMON";
/** Diagnostics for the client's stderr; never forwarded to the agent. */
export const LOG_METHOD = "$/foreman/log";

/** Handshake lines (hello, challenge, auth, ok) are small. */
export const MAX_HANDSHAKE_LINE = 64 * 1024;
/** A hook request carries the PreToolUse payload (at most 4 MiB of text,
 *  which JSON escaping can grow). */
export const MAX_HOOK_LINE = 32 * 1024 * 1024;
/** What a client accepts from the daemon in one line. */
export const MAX_DAEMON_LINE = 64 * 1024 * 1024;
/** An unauthenticated connection is dropped after this long. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Unix socket paths are limited (104 bytes on macOS, 108 on Linux). */
export const MAX_SOCKET_PATH = 100;

export interface DaemonFiles {
  socketPath: string;
  tokenPath: string;
}

export function daemonFiles(stateDir: string): DaemonFiles {
  return {
    socketPath: join(stateDir, DAEMON_SOCKET_FILE),
    tokenPath: join(stateDir, DAEMON_TOKEN_FILE),
  };
}

/** Windows has no Unix-socket file permissions to rely on: Foreman keeps
 *  the in-process path there. */
export function daemonSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function daemonDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[NO_DAEMON_ENV]?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

export type ProofRole = "daemon" | "client";

export function daemonProof(token: string, role: ProofRole, nonce: string): string {
  return createHmac("sha256", token).update(`foreman-daemon/${DAEMON_PROTOCOL_VERSION}\u0000${role}\u0000${nonce}`).digest("hex");
}

export function proofMatches(token: string, role: ProofRole, nonce: string, presented: unknown): boolean {
  if (typeof presented !== "string" || !/^[0-9a-f]{64}$/.test(presented)) return false;
  const want = Buffer.from(daemonProof(token, role, nonce), "hex");
  return timingSafeEqual(want, Buffer.from(presented, "hex"));
}

/** A nonce: 32 random bytes in hex. */
export const NONCE_RE = /^[0-9a-f]{64}$/;

/** Splits a byte stream into lines, refusing any line longer than
 *  `maxLine` characters (the peer is then dropped). */
export class LineReader {
  private buffer = "";
  constructor(private maxLine: number) {}

  setMaxLine(maxLine: number): void {
    this.maxLine = maxLine;
  }

  /** Complete lines so far, or "overflow" when a line is too long. */
  push(chunk: string): string[] | "overflow" {
    this.buffer += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      if (nl > this.maxLine) return "overflow";
      lines.push(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
    if (this.buffer.length > this.maxLine) return "overflow";
    return lines;
  }

  /** What is left after the last complete line. */
  rest(): string {
    return this.buffer;
  }
}

/** Parse one line as a JSON object; null for anything else. */
export function parseObjectLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
