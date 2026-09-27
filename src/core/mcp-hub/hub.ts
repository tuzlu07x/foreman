import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  enabledServers,
  MissingSecretError,
  resolveSecretRefs,
  TOOL_SEPARATOR,
  toolRuleEffect,
  type HubConfig,
  type ServerConfig,
  type ToolRuleEffect,
} from "./config.js";
import { redactSecretShapes } from "../risk-rules/secret-patterns.js";
import { serverFingerprint, ToolPinStore, type PinnedTool } from "./pins.js";
import { guardToolResult, type ResultGuardStats } from "./result-guard.js";
import { hasBlockingFinding, scanToolDefinition, type ToolScanFinding } from "./tool-scan.js";
import {
  sdkUpstreamClientFactory,
  type ResolvedServer,
  type UpstreamClient,
  type UpstreamClientFactory,
  type UpstreamTool,
} from "./upstream.js";

// =============================================================================
// McpHub — mediated MCP proxy for every agent behind `foreman mcp-stdio`
// =============================================================================
//
// The hub owns the upstream MCP servers declared in mcp.yaml. It decides
// which of their tools an agent may even *see* (mcp.yaml deny rules, the
// org chart's per-department server list, scanner quarantine, pin drift),
// shapes the listing to spend as few context tokens as possible
// (description clipping, lazy discovery), and executes calls the mediator
// already approved (result guard). It never makes the allow/deny decision
// itself — that stays with policy + risk + human approval.

export const SEARCH_TOOL = "foreman_search_tools";
export const CALL_TOOL = "foreman_call_tool";

export type HubToolStatus = "available" | "quarantined" | "denied";

export interface HubTool {
  server: string;
  /** Name as the upstream server knows it. */
  name: string;
  /** Name agents see and policy rules match: `<server>__<name>`. */
  exposedName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: unknown;
  rule: ToolRuleEffect | null;
  status: HubToolStatus;
  reasons: string[];
  findings: ToolScanFinding[];
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: unknown;
}

export interface ServerStatus {
  name: string;
  kind: "stdio" | "http";
  source: "live" | "pinned-cache" | "unavailable";
  error: string | null;
  tools: number;
  quarantined: number;
  /** Listed from the pinned cache: tools the last live check found that
   *  weren't pinned, withheld until you review them (#634). */
  newSincePinning: string[];
}

export type HubCallResolution =
  | { kind: "tool"; tool: HubTool; args: Record<string, unknown> }
  | { kind: "search"; query: string; limit: number }
  | { kind: "unavailable"; message: string };

/** Per-agent view: the org chart can restrict which servers an agent sees.
 *  `null` = no restriction. */
export interface AgentScope {
  allowedServers?: ReadonlySet<string> | null;
}

export class HubToolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubToolUnavailableError";
  }
}

export interface McpHubOptions {
  config: HubConfig;
  /** Secret-store lookup; `null` means the secret does not exist. */
  resolveSecret: (name: string) => string | null;
  pins: ToolPinStore;
  clientFactory?: UpstreamClientFactory;
  now?: () => number;
}

interface ServerState {
  name: string;
  config: ServerConfig;
  fingerprint: string;
  client: UpstreamClient | null;
  connecting: Promise<UpstreamClient> | null;
  tools: HubTool[] | null;
  source: ServerStatus["source"];
  /** Live definitions were compared against the pins this session. */
  verified: boolean;
  error: string | null;
  /** Secret values resolved into this server's launch config; scrubbed
   *  from upstream error text before it reaches an agent or the audit log. */
  secretValues: string[];
}

export class McpHub {
  private readonly servers = new Map<string, ServerState>();
  private readonly clientFactory: UpstreamClientFactory;
  private readonly now: () => number;

  constructor(private readonly opts: McpHubOptions) {
    this.clientFactory = opts.clientFactory ?? sdkUpstreamClientFactory;
    this.now = opts.now ?? (() => Date.now());
    for (const [name, config] of enabledServers(opts.config)) {
      this.servers.set(name, {
        name,
        config,
        fingerprint: serverFingerprint({
          ...(config.command ? { command: config.command } : {}),
          args: config.args,
          ...(config.url ? { url: config.url } : {}),
        }),
        client: null,
        connecting: null,
        tools: null,
        source: "unavailable",
        verified: false,
        error: null,
        secretValues: [],
      });
    }
  }

  get serverNames(): string[] {
    return [...this.servers.keys()];
  }

  get isEmpty(): boolean {
    return this.servers.size === 0;
  }

  /** Every tool of every enabled server, hidden ones included (for the CLI).
   *  Uses pinned definitions when available unless `refresh` is set. */
  async inventory(opts: { refresh?: boolean; servers?: readonly string[] } = {}): Promise<HubTool[]> {
    const states = [...this.servers.values()].filter(
      (s) => !opts.servers || opts.servers.includes(s.name),
    );
    await Promise.all(states.map((s) => this.loadServerTools(s, opts.refresh === true)));
    return states.flatMap((s) => s.tools ?? []);
  }

  status(): ServerStatus[] {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      kind: s.config.url ? "http" : "stdio",
      source: s.source,
      error: s.error,
      tools: (s.tools ?? []).filter((t) => t.status === "available").length,
      quarantined: (s.tools ?? []).filter((t) => t.status === "quarantined").length,
      newSincePinning:
        s.source === "pinned-cache" && this.opts.config.security.pin_tool_definitions
          ? (this.opts.pins.get(s.name, s.fingerprint)?.drift?.added ?? [])
          : [],
    }));
  }

  /** The hub's share of an agent's `tools/list`. */
  async listForAgent(scope: AgentScope = {}): Promise<AgentTool[]> {
    const visible = this.visible(await this.inventory(), scope);
    if (visible.length === 0) return [];
    if (this.effectiveMode(visible.length) === "lazy") return this.metaTools(visible);
    const maxDesc = this.opts.config.limits.max_description_chars;
    return visible.map((t) => compactForAgent(t, maxDesc));
  }

  effectiveMode(visibleCount: number): "eager" | "lazy" {
    const { mode, limits } = this.opts.config;
    if (mode === "auto") return visibleCount > limits.lazy_threshold ? "lazy" : "eager";
    return mode;
  }

  /** Map an agent's `tools/call` onto a hub tool. `null` = not a hub tool. */
  async resolveCall(
    name: string,
    rawArgs: unknown,
    scope: AgentScope = {},
  ): Promise<HubCallResolution | null> {
    if (this.isEmpty) return null;
    const args = isRecord(rawArgs) ? rawArgs : {};
    if (name === SEARCH_TOOL) {
      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(10, Math.max(1, Math.floor(args.limit)))
          : 5;
      return { kind: "search", query, limit };
    }
    let target = name;
    let callArgs = args;
    if (name === CALL_TOOL) {
      if (typeof args.name !== "string" || args.name.length === 0) {
        return { kind: "unavailable", message: `${CALL_TOOL} requires args.name` };
      }
      target = args.name;
      callArgs = isRecord(args.arguments) ? args.arguments : {};
    }
    const sep = target.indexOf(TOOL_SEPARATOR);
    const serverName = sep > 0 ? target.slice(0, sep) : "";
    const state = this.servers.get(serverName);
    if (!state) {
      return name === CALL_TOOL
        ? { kind: "unavailable", message: `Unknown tool '${target}' — use ${SEARCH_TOOL} to find one` }
        : null;
    }
    if (!serverAllowed(serverName, scope)) {
      return {
        kind: "unavailable",
        message: `Your role in org.yaml does not include the '${serverName}' MCP server. Ask your manager or the user.`,
      };
    }
    await this.loadServerTools(state, false);
    const tool = (state.tools ?? []).find((t) => t.exposedName === target);
    if (!tool) {
      return { kind: "unavailable", message: `Server '${serverName}' has no tool '${target}'` };
    }
    if (tool.status !== "available") {
      return { kind: "unavailable", message: unavailableMessage(tool) };
    }
    return { kind: "tool", tool, args: callArgs };
  }

  /** Lazy-mode discovery: best matches for a free-text query. */
  async search(query: string, limit: number, scope: AgentScope = {}): Promise<AgentTool[]> {
    const visible = this.visible(await this.inventory(), scope);
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const maxDesc = this.opts.config.limits.max_description_chars;
    return visible
      .map((t) => ({ t, score: scoreTool(t, terms) }))
      .filter((x) => terms.length === 0 || x.score > 0)
      .sort((a, b) => b.score - a.score || a.t.exposedName.localeCompare(b.t.exposedName))
      .slice(0, limit)
      .map(({ t }) => compactForAgent(t, maxDesc));
  }

  /** Execute a call the mediator already allowed. */
  async call(
    tool: HubTool,
    args: Record<string, unknown>,
  ): Promise<{ result: CallToolResult; stats: ResultGuardStats; durationMs: number }> {
    const state = this.servers.get(tool.server);
    if (!state) throw new HubToolUnavailableError(`No MCP server '${tool.server}' is enabled`);
    const client = await this.connect(state);
    // Cached (pinned) listings are re-verified against the live server
    // before the first call, so a rug pull is caught before it runs.
    if (!state.verified) {
      await this.verifyLive(state, client).catch((err: unknown) => {
        throw this.scrubbed(state, err);
      });
    }
    const live = (state.tools ?? []).find((t) => t.exposedName === tool.exposedName);
    if (!live || live.status !== "available") {
      throw new HubToolUnavailableError(
        live ? unavailableMessage(live) : `Server '${tool.server}' no longer offers '${tool.name}'`,
      );
    }
    const started = this.now();
    const raw = await client
      .callTool(tool.name, args, state.config.timeout_seconds * 1000)
      .catch((err: unknown) => {
        throw this.scrubbed(state, err);
      });
    const { security, limits } = this.opts.config;
    const guarded = guardToolResult(raw, {
      maxChars: limits.max_result_chars,
      redactSecrets: security.redact_secrets_in_results,
      flagInjection: security.flag_injection_in_results,
    });
    return { ...guarded, durationMs: this.now() - started };
  }

  /** Re-pin a server's current live definitions (accepts drift). */
  async trust(serverName: string, opts: { includeFlagged?: boolean } = {}): Promise<HubTool[]> {
    const state = this.servers.get(serverName);
    if (!state) throw new HubToolUnavailableError(`No MCP server '${serverName}' is enabled`);
    const client = await this.connect(state);
    const live = await client.listTools();
    const flagged = new Set<string>();
    if (opts.includeFlagged) {
      for (const t of live) if (hasBlockingFinding(scanToolDefinition(t))) flagged.add(t.name);
    }
    this.opts.pins.pin(serverName, state.fingerprint, live, {
      now: this.now(),
      trustedDespiteFindings: flagged,
    });
    state.tools = this.evaluate(state, live, { justPinned: true });
    state.source = "live";
    state.verified = true;
    state.error = null;
    return state.tools;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map(async (s) => {
        const client = s.client;
        s.client = null;
        s.connecting = null;
        if (client) await client.close().catch(() => undefined);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private visible(tools: HubTool[], scope: AgentScope): HubTool[] {
    return tools.filter((t) => t.status === "available" && serverAllowed(t.server, scope));
  }

  private async loadServerTools(state: ServerState, refresh: boolean): Promise<void> {
    if (state.tools && !refresh) return;
    const pinning = this.opts.config.security.pin_tool_definitions;
    const pinned = pinning ? this.opts.pins.get(state.name, state.fingerprint) : null;
    if (pinned && !refresh) {
      state.tools = this.evaluate(
        state,
        Object.values(pinned.tools).map((p) => p.definition),
        { fromCache: true },
      );
      state.source = "pinned-cache";
      return;
    }
    try {
      const client = await this.connect(state);
      await this.verifyLive(state, client);
    } catch (err) {
      state.error = this.scrub(state, describeError(err));
      state.source = "unavailable";
      state.tools = state.tools ?? [];
    }
  }

  private async verifyLive(state: ServerState, client: UpstreamClient): Promise<void> {
    const live = await client.listTools();
    const pinning = this.opts.config.security.pin_tool_definitions;
    let justPinned = false;
    if (pinning && !this.opts.pins.get(state.name, state.fingerprint)) {
      // Trust on first use: the definitions the user first connected to
      // become the baseline every later session is compared against.
      this.opts.pins.pin(state.name, state.fingerprint, live, { now: this.now() });
      justPinned = true;
    }
    if (pinning && !justPinned) {
      const diff = this.opts.pins.diff(state.name, state.fingerprint, live);
      this.opts.pins.recordDrift(state.name, state.fingerprint, { changed: diff.changed, added: diff.added }, this.now());
    }
    state.tools = this.evaluate(state, live, { justPinned });
    state.source = "live";
    state.verified = true;
    state.error = null;
  }

  private evaluate(
    state: ServerState,
    tools: readonly UpstreamTool[],
    ctx: { fromCache?: boolean; justPinned?: boolean },
  ): HubTool[] {
    const { security } = this.opts.config;
    const pins = security.pin_tool_definitions
      ? this.opts.pins.get(state.name, state.fingerprint)
      : null;
    const diff =
      pins && !ctx.fromCache && !ctx.justPinned
        ? this.opts.pins.diff(state.name, state.fingerprint, tools)
        : null;
    return tools.map((t) => {
      const rule = toolRuleEffect(state.config.tools, t.name);
      const findings = scanToolDefinition(t);
      const reasons: string[] = [];
      let status: HubToolStatus = "available";
      if (rule === "deny") {
        status = "denied";
        reasons.push("denied by tools.deny in mcp.yaml");
      } else {
        const pinnedTool: PinnedTool | undefined = pins?.tools[t.name];
        if (
          security.quarantine_suspicious_tools &&
          hasBlockingFinding(findings) &&
          !pinnedTool?.trustedDespiteFindings
        ) {
          status = "quarantined";
          reasons.push(
            `suspicious definition: ${findings
              .filter((f) => f.severity === "high")
              .map((f) => f.reason)
              .join("; ")}`,
          );
        }
        const driftSeen = ctx.fromCache && pins?.drift?.changed.includes(t.name) ? pins.drift.seenAt : null;
        if (diff?.changed.includes(t.name)) {
          status = "quarantined";
          reasons.push("definition changed since it was pinned (possible rug pull)");
        } else if (driftSeen !== null) {
          // From the cache: the live server was last seen with a different
          // definition, so keep it withheld until you review it (#634).
          status = "quarantined";
          reasons.push(
            `definition changed since it was pinned (possible rug pull; seen ${new Date(driftSeen).toISOString().slice(0, 16).replace("T", " ")} UTC)`,
          );
        } else if (diff?.added.includes(t.name)) {
          status = "quarantined";
          reasons.push("new tool appeared after the server was pinned");
        }
      }
      return {
        server: state.name,
        name: t.name,
        exposedName: `${state.name}${TOOL_SEPARATOR}${t.name}`,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: normaliseSchema(t.inputSchema),
        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        rule,
        status,
        reasons,
        findings,
      };
    });
  }

  private async connect(state: ServerState): Promise<UpstreamClient> {
    if (state.client) return state.client;
    if (!state.connecting) {
      state.connecting = (async () => {
        const client = this.clientFactory(this.resolveServer(state));
        try {
          await client.connect();
        } catch (err) {
          await client.close().catch(() => undefined);
          throw this.scrubbed(state, err);
        }
        state.client = client;
        return client;
      })().finally(() => {
        state.connecting = null;
      });
    }
    return state.connecting;
  }

  /** Upstream error text (including the server's stderr tail) can echo a
   *  token back; mask the values Foreman injected and anything secret-shaped. */
  private scrub(state: ServerState, text: string): string {
    let out = text;
    for (const value of state.secretValues) {
      if (value.length >= 4) out = out.split(value).join("[redacted]");
    }
    return redactSecretShapes(out).text;
  }

  private scrubbed(state: ServerState, err: unknown): Error {
    if (err instanceof HubToolUnavailableError || err instanceof MissingSecretError) return err;
    return new Error(this.scrub(state, describeError(err)));
  }

  private resolveServer(state: ServerState): ResolvedServer {
    const secrets: string[] = [];
    const lookup = (name: string): string | null => {
      const value = this.opts.resolveSecret(name);
      if (value) secrets.push(value);
      return value;
    };
    state.secretValues = secrets;
    const resolve = (v: string): string => resolveSecretRefs(state.name, v, lookup);
    const c = state.config;
    if (c.url) {
      return { kind: "http", name: state.name, url: resolve(c.url), headers: mapValues(c.headers, resolve) };
    }
    return {
      kind: "stdio",
      name: state.name,
      command: c.command!,
      args: c.args.map(resolve),
      env: mapValues(c.env, resolve),
      ...(c.cwd ? { cwd: c.cwd } : {}),
    };
  }

  private metaTools(visible: HubTool[]): AgentTool[] {
    const perServer = new Map<string, number>();
    for (const t of visible) perServer.set(t.server, (perServer.get(t.server) ?? 0) + 1);
    const summary = [...perServer.entries()].map(([s, n]) => `${s} (${n})`).join(", ");
    return [
      {
        name: SEARCH_TOOL,
        description:
          `Find tools on the MCP servers Foreman runs for you: ${summary}. ` +
          `Returns matching tools with their input schemas; run one with ${CALL_TOOL}.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What you want to do, e.g. 'create github issue'." },
            limit: { type: "integer", minimum: 1, maximum: 10, description: "Max results (default 5)." },
          },
          required: ["query"],
        },
      },
      {
        name: CALL_TOOL,
        description: `Run a tool found with ${SEARCH_TOOL}. Foreman applies your policy and may ask the user first.`,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact tool name from the search results." },
            arguments: { type: "object", description: "Arguments matching the tool's input schema." },
          },
          required: ["name"],
        },
      },
    ];
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

/** Rough token estimate (~4 chars per token) for listing-cost reports. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function compactForAgent(tool: HubTool, maxDesc: number): AgentTool {
  return {
    name: tool.exposedName,
    description: clip(tool.description ?? "", maxDesc),
    inputSchema: clipSchemaDescriptions(tool.inputSchema, Math.max(80, Math.floor(maxDesc / 2)), 0) as Record<
      string,
      unknown
    >,
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

function serverAllowed(server: string, scope: AgentScope): boolean {
  return !scope.allowedServers || scope.allowedServers.has(server);
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function clipSchemaDescriptions(node: unknown, max: number, depth: number): unknown {
  if (depth > 12 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => clipSchemaDescriptions(n, max, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema") continue;
    out[key] =
      key === "description" && typeof value === "string"
        ? clip(value, max)
        : clipSchemaDescriptions(value, max, depth + 1);
  }
  return out;
}

function scoreTool(tool: HubTool, terms: string[]): number {
  const name = tool.exposedName.toLowerCase();
  const desc = (tool.description ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    if (desc.includes(term)) score += 1;
  }
  return score;
}

function unavailableMessage(tool: HubTool): string {
  const why = tool.reasons.join("; ") || tool.status;
  const hint =
    tool.status === "denied"
      ? "Remove it from tools.deny in mcp.yaml to enable it."
      : `Review it with \`foreman mcp tools ${tool.server} --refresh\`, then \`foreman mcp trust ${tool.server}\` if you accept it.`;
  return `Foreman withheld '${tool.exposedName}': ${why}. ${hint}`;
}

function normaliseSchema(schema: unknown): Record<string, unknown> {
  return isRecord(schema) ? schema : { type: "object", properties: {} };
}

function mapValues(input: Record<string, string>, fn: (v: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[k] = fn(v);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  if (err instanceof MissingSecretError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
