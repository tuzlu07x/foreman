import { connectDaemon } from "../core/daemon/client.js";
import { LOG_METHOD, LineReader, MAX_DAEMON_LINE, parseObjectLine } from "../core/daemon/protocol.js";
import { createDecoder, encodeMessage } from "../mcp/framing.js";

// =============================================================================
// `foreman mcp-stdio` as a thin client of the daemon (#616)
// =============================================================================
//
// When the daemon is up, this process only relays JSON-RPC frames between
// the agent (stdin / stdout) and the daemon's socket. The daemon proves the
// agent's identity from the token this process passes on, mediates every
// call and runs the hub servers once for all agents.
//
// Fail closed: when the daemon goes away, every call it had not answered
// gets a JSON-RPC error — its outcome is unknown and it is never sent
// again. Only then does this process start serving the agent itself, for
// the calls that come after (`onLost`).

export interface RelayState {
  /** The agent already sent `initialize`. */
  initialized: boolean;
  /** A partial frame from stdin that had not been forwarded. */
  rest: string;
}

export interface StdinSource {
  attach(sink: (chunk: string) => void, onEnd: () => void): void;
  detach(): void;
}

export interface RelayOptions {
  source: string | undefined;
  token: string | undefined;
  stateDir: string;
  stdin: StdinSource;
  approvalTimeoutMs: number;
  onLost: (state: RelayState) => void;
  /** Tests. */
  write?: (frame: string) => void;
  warn?: (message: string) => void;
  exit?: (code: number) => void;
}

const PARSE_ERROR_FRAME = `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`;

/** How long after the agent closed stdin we wait for the daemon to finish
 *  (it drains for up to 5 s), before exiting anyway. */
const CLOSE_WAIT_MS = 8_000;

/** Relay through the daemon. Resolves false when no daemon could be used
 *  and nothing was forwarded: serve the agent in-process instead. */
export async function relayThroughDaemon(opts: RelayOptions): Promise<boolean> {
  const write = opts.write ?? defaultWrite;
  const say = opts.warn ?? defaultWarn;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const connected = await connectDaemon({
    stateDir: opts.stateDir,
    auth: {
      role: "mcp",
      source: opts.source ?? null,
      agentToken: opts.token ?? null,
      approvalTimeoutMs: opts.approvalTimeoutMs,
    },
  });
  if (connected.kind === "absent") {
    if (connected.notable) say(`not using the Foreman daemon: ${connected.reason}; serving in this process`);
    return false;
  }
  if (connected.kind === "refused") {
    say(`the Foreman daemon refused this connection (${connected.reason}); serving in this process`);
    return false;
  }

  const { socket, reader, pending: early } = connected.link;
  reader.setMaxLine(MAX_DAEMON_LINE);
  const decoder = createDecoder();
  /** Requests forwarded and not yet answered. */
  const unanswered = new Map<string, string | number>();
  let initialized = false;
  let stdinEnded = false;
  let done = false;

  const idKey = (id: unknown): string | null =>
    typeof id === "string" || typeof id === "number" ? `${typeof id}:${id}` : null;

  const fromDaemon = (lines: string[]): boolean => {
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const msg = parseObjectLine(line);
      if (!msg) return false;
      if (msg.method === LOG_METHOD) {
        const text = (msg.params as { message?: unknown } | undefined)?.message;
        if (typeof text === "string") say(text.slice(0, 4000));
        continue;
      }
      if ("result" in msg || "error" in msg) {
        const key = idKey(msg.id);
        if (key) unanswered.delete(key);
      }
      write(`${line}\n`);
    }
    return true;
  };

  const lost = (why: string): void => {
    if (done) return;
    done = true;
    opts.stdin.detach();
    socket.destroy();
    if (stdinEnded) return exit(0);
    for (const id of unanswered.values()) {
      write(
        encodeMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message:
              "Foreman's daemon stopped before answering this call, so its outcome is unknown and nothing was returned. " +
              "It was not retried; Foreman now serves this session from the agent's own process.",
          },
        } as Parameters<typeof encodeMessage>[0]),
      );
    }
    unanswered.clear();
    say(`${why}; serving this session in this process from now on`);
    opts.onLost({ initialized, rest: decoder.remainder() });
  };

  socket.on("data", (chunk: string) => {
    const lines = reader.push(chunk);
    if (lines === "overflow") return lost("the Foreman daemon sent an oversized frame");
    if (!fromDaemon(lines)) lost("the Foreman daemon sent a malformed frame");
  });
  socket.on("close", () => {
    if (stdinEnded && !done) {
      done = true;
      return exit(0);
    }
    lost("the Foreman daemon went away");
  });
  if (connected.link.isClosed()) {
    lost("the Foreman daemon went away");
    return true;
  }

  opts.stdin.attach(
    (chunk) => {
      if (done) return;
      const { messages, parseErrors } = decoder.push(chunk);
      // Answered here exactly as the in-process session would.
      for (let i = 0; i < parseErrors; i++) write(PARSE_ERROR_FRAME);
      for (const message of messages) {
        const method = "method" in message ? message.method : undefined;
        const key = "id" in message ? idKey(message.id) : null;
        if (method === "initialize") initialized = true;
        if (method !== undefined && key !== null && "id" in message) {
          unanswered.set(key, message.id as string | number);
        }
        socket.write(encodeMessage(message));
      }
    },
    () => {
      // The agent closed its end: the daemon cancels what is still
      // waiting on a human and closes the connection.
      stdinEnded = true;
      socket.end();
      setTimeout(() => {
        if (!done) {
          done = true;
          exit(0);
        }
      }, CLOSE_WAIT_MS).unref();
    },
  );
  const stop = (): void => {
    stdinEnded = true;
    socket.destroy();
  };
  process.stdout.on("error", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  socket.resume();
  if (!fromDaemon(early)) lost("the Foreman daemon sent a malformed frame");
  return true;
}

function defaultWrite(frame: string): void {
  try {
    process.stdout.write(frame);
  } catch {
    // the agent is gone; stdout's "error" handler stops the relay
  }
}

function defaultWarn(message: string): void {
  process.stderr.write(`foreman mcp-stdio: ${message}\n`);
}
