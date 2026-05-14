import type { MediatorService } from "./mediator.js";
import type { RegistryService } from "./registry.js";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
} from "../mcp/types.js";

export interface WrapTransport {
  start(): void;
  send(msg: JSONRPCMessage): void;
  stop(): void;
  isAlive(): boolean;
  pid(): number | undefined;
}

export interface WrapTransportFactoryOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onMessage: (msg: JSONRPCMessage) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (err: Error) => void;
}

export type WrapTransportFactory = (
  opts: WrapTransportFactoryOptions,
) => WrapTransport;

export interface WrapRunnerOptions {
  agentId: string;
  displayName?: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  restart?: "never" | "on-failure";
  registry: RegistryService;
  mediator: MediatorService;
  transportFactory: WrapTransportFactory;
  onLog?: (line: string) => void;
}

export interface WrapSession {
  agentId: string;
  // First wrap of a given id mints a fresh keypair; subsequent wraps reuse it.
  privateKey?: Buffer;
  // Resolves when the child process exits and the runner is done. Value is the
  // child's exit code, or the last code observed when restart-on-failure
  // eventually gave up.
  done: Promise<number | null>;
  stop(): void;
}

const RESTART_BACKOFF_MS = 1000;
const MAX_RESTARTS = 5;

// For `tools/call` we want the tool name (params.name) so policy rules
// like `tool:read_file` match correctly. For any other method (e.g.
// `resources/read`) we fall back to the method string itself.
function extractToolName(req: JSONRPCRequest): string | undefined {
  if (req.method === "tools/call") {
    const params = req.params as { name?: unknown } | undefined;
    if (typeof params?.name === "string") return params.name;
  }
  return typeof req.method === "string" ? req.method : undefined;
}

// Spawns the agent via the supplied transport factory, registers (or reuses)
// its identity, routes every inbound MCP message through the mediator, and
// sends a JSON-RPC response back to the child for every request. Pure-ish:
// the transport (and therefore the child process) is injected so tests can
// fake it without spawning anything.
export function runWrap(options: WrapRunnerOptions): WrapSession {
  const log = options.onLog ?? ((line) => console.error(line));
  const existing = options.registry.get(options.agentId);
  let privateKey: Buffer | undefined;
  if (!existing) {
    const result = options.registry.register({
      id: options.agentId,
      displayName: options.displayName ?? options.agentId,
      transport: "wrap",
    });
    privateKey = result.privateKey;
    if (privateKey) {
      log(
        `(wrap) registered new agent "${options.agentId}" — store the private key now (printed once):`,
      );
      log(privateKey.toString("hex"));
    }
  } else {
    log(`(wrap) reusing existing identity for "${options.agentId}"`);
  }

  let stopRequested = false;
  let restartCount = 0;
  let resolveDone: (code: number | null) => void;
  const done = new Promise<number | null>((res) => {
    resolveDone = res;
  });
  let currentTransport: WrapTransport | null = null;

  const handleMessage = async (msg: JSONRPCMessage): Promise<void> => {
    if (!("method" in msg) || !("id" in msg)) {
      // notifications / responses from the child have no id we need to answer.
      return;
    }
    const request = msg as JSONRPCRequest;
    const targetTool = extractToolName(request);
    try {
      const result = await options.mediator.handleRequest({
        sourceAgent: options.agentId,
        targetTool,
        message: msg,
      });
      const response: JSONRPCResponse | { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } } =
        result.decision === "allowed"
          ? {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `(foreman) ${request.method ?? "request"} allowed by ${result.decidedBy}`,
                  },
                ],
              },
            } as unknown as JSONRPCResponse
          : {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32603,
                message: `Denied by ${result.decidedBy}`,
              },
            };
      currentTransport?.send(response as JSONRPCMessage);
    } catch (err) {
      currentTransport?.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      } as unknown as JSONRPCMessage);
    }
  };

  const start = (): void => {
    const transport = options.transportFactory({
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
      onMessage: (msg) => {
        void handleMessage(msg);
      },
      onExit: (code, signal) => {
        log(
          `(wrap) child exited code=${code} signal=${signal ?? "none"}${
            stopRequested ? " (stop requested)" : ""
          }`,
        );
        if (stopRequested) {
          resolveDone(code);
          return;
        }
        const shouldRestart =
          options.restart === "on-failure" &&
          code !== 0 &&
          restartCount < MAX_RESTARTS;
        if (shouldRestart) {
          restartCount += 1;
          log(`(wrap) restarting (attempt ${restartCount}/${MAX_RESTARTS})…`);
          setTimeout(() => {
            if (!stopRequested) start();
          }, RESTART_BACKOFF_MS).unref?.();
          return;
        }
        resolveDone(code);
      },
      onError: (err) => {
        log(`(wrap) transport error: ${err.message}`);
      },
    });
    currentTransport = transport;
    transport.start();
  };

  start();

  return {
    agentId: options.agentId,
    privateKey,
    done,
    stop(): void {
      stopRequested = true;
      currentTransport?.stop();
    },
  };
}
