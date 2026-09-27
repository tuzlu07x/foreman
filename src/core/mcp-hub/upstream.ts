import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FOREMAN_VERSION } from "../../version.js";

// =============================================================================
// Upstream MCP connections
// =============================================================================
//
// Thin seam over the official SDK client so the hub can be unit-tested with
// an in-memory fake. Stdio children get a minimal environment (the SDK's
// safe-list: HOME, PATH, USER, …) plus only the variables the server's
// config declares — they never inherit Foreman's own environment.

/** The slice of an MCP tool definition the hub keeps (and pins). */
export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface UpstreamClient {
  connect(): Promise<void>;
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface ResolvedStdioServer {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface ResolvedHttpServer {
  kind: "http";
  name: string;
  url: string;
  headers: Record<string, string>;
}

export type ResolvedServer = ResolvedStdioServer | ResolvedHttpServer;

export type UpstreamClientFactory = (server: ResolvedServer) => UpstreamClient;

const LIST_TIMEOUT_MS = 30_000;
/** First launch of an `npx` / `uvx` server downloads the package. */
const CONNECT_TIMEOUT_MS = 120_000;
const STDERR_TAIL_CHARS = 2_000;

/** Network plumbing a server needs to reach its API (and npx/uvx need to
 *  download it) — proxies and CA bundles, never credentials of the user's
 *  other tools. Everything else in Foreman's environment stays behind. */
const PASSTHROUGH_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "LANG",
  "TZ",
];

function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
const MAX_TOOLS_PER_SERVER = 500;
const MAX_LIST_PAGES = 20;

export const sdkUpstreamClientFactory: UpstreamClientFactory = (server) =>
  new SdkUpstreamClient(server);

class SdkUpstreamClient implements UpstreamClient {
  private readonly client = new Client(
    { name: "foreman-mcp-hub", version: FOREMAN_VERSION },
    { capabilities: {} },
  );
  private connected = false;

  constructor(private readonly server: ResolvedServer) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    let stderrTail = "";
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (this.server.kind === "stdio") {
      const stdio = new StdioClientTransport({
        command: this.server.command,
        args: this.server.args,
        env: { ...getDefaultEnvironment(), ...passthroughEnv(), ...this.server.env },
        ...(this.server.cwd ? { cwd: this.server.cwd } : {}),
        // Piped, never inherited: upstream chatter must not reach the
        // agent's stdio channel. The tail explains a failed start.
        stderr: "pipe",
      });
      stdio.stderr?.on("data", (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      });
      transport = stdio;
    } else {
      transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
        requestInit: { headers: this.server.headers },
      });
    }
    try {
      await this.client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const tail = stderrTail.trim().split("\n").slice(-3).join(" | ");
      throw new Error(tail ? `${reason} — server said: ${tail}` : reason);
    }
    this.connected = true;
  }

  async listTools(): Promise<UpstreamTool[]> {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await this.client.listTools(cursor ? { cursor } : undefined, {
        timeout: LIST_TIMEOUT_MS,
      });
      for (const t of res.tools) {
        tools.push({
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          inputSchema: t.inputSchema,
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        });
        if (tools.length >= MAX_TOOLS_PER_SERVER) return tools;
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<CallToolResult> {
    const res = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs,
    });
    return res as CallToolResult;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.close();
  }
}
