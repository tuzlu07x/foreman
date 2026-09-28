import { statSync } from "node:fs";
import { canonicalJson } from "./pins.js";
import {
  buildHub,
  readHubConfigOrNull,
  scopeForAgent,
  type HubPaths,
} from "./boot.js";
import type { HubConfig } from "./config.js";
import type { AgentScope, McpHub } from "./hub.js";
import type { McpOAuthSecretStore } from "./oauth-store.js";

// =============================================================================
// HubRuntime — the hub a running `foreman mcp-stdio` uses, kept current
// =============================================================================
//
// `foreman integrations disable jira` (or any edit of mcp.yaml / org.yaml)
// must reach agents that are already connected, not only the next ones.
// Before every hub listing or call, sync() stats both files (at most once a
// second): when either changed, the hub and the agent's scope are rebuilt
// from the files as they are now. A file that no longer parses means no
// hub servers at all (fail closed), never the last good copy.
//
// The replaced hub keeps serving the calls already running on it and is
// closed when the last one finishes.

export interface HubRuntimeOptions {
  paths: HubPaths & { orgConfigPath: string };
  secretStore: McpOAuthSecretStore;
  /** The connected agent (its identity can change mid-session). */
  agentId: string;
  onError?: (message: string) => void;
  /** Called after a rebuild that may change what the agent sees, so the
   *  client can be told (`notifications/tools/list_changed`). */
  onToolsChanged?: () => void;
  /** Minimum time between two stats of the files. Default 1000 ms. */
  throttleMs?: number;
  now?: () => number;
  /** Tests: build the hub from a config. */
  build?: (config: HubConfig) => McpHub | null;
}

interface Generation {
  hub: McpHub | null;
  inFlight: number;
  retired: boolean;
}

export class HubRuntime {
  private current: Generation = { hub: null, inFlight: 0, retired: false };
  private currentScope: AgentScope = { allowedServers: new Set() };
  private agentId: string;
  private signature: string | null = null;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private viewKey = "";
  private readonly now: () => number;
  private readonly throttleMs: number;

  constructor(private readonly opts: HubRuntimeOptions) {
    this.agentId = opts.agentId;
    this.now = opts.now ?? Date.now;
    this.throttleMs = opts.throttleMs ?? 1000;
    this.sync({ force: true, quiet: true });
  }

  get hub(): McpHub | null {
    return this.current.hub;
  }

  get scope(): AgentScope {
    return this.currentScope;
  }

  /** The agent's identity changed (token rotated, agent removed): its
   *  scope is recomputed at once. */
  setAgent(agentId: string): void {
    if (agentId === this.agentId) return;
    this.agentId = agentId;
    this.sync({ force: true });
  }

  /** Rebuild when mcp.yaml or org.yaml changed. `force` skips the
   *  throttle (used right before a call runs). */
  sync(opts: { force?: boolean; quiet?: boolean } = {}): void {
    const now = this.now();
    if (!opts.force && now - this.lastCheck < this.throttleMs) return;
    this.lastCheck = now;
    const signature = `${this.agentId}\u0000${fileSignature(this.opts.paths.mcpConfigPath)}\u0000${fileSignature(this.opts.paths.orgConfigPath)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.rebuild(opts.quiet === true);
  }

  /** Run `fn` on the current hub, keeping that hub open until it returns. */
  async run<T>(fn: (hub: McpHub) => Promise<T>): Promise<T> {
    const gen = this.current;
    if (!gen.hub) throw new Error("no MCP hub is configured");
    gen.inFlight++;
    try {
      return await fn(gen.hub);
    } finally {
      gen.inFlight--;
      if (gen.retired && gen.inFlight === 0) void gen.hub.close();
    }
  }

  async close(): Promise<void> {
    const gen = this.current;
    this.current = { hub: null, inFlight: 0, retired: false };
    gen.retired = true;
    if (gen.hub && gen.inFlight === 0) await gen.hub.close();
  }

  private rebuild(quiet: boolean): void {
    const onError = this.opts.onError ?? (() => undefined);
    const config = readHubConfigOrNull(this.opts.paths, onError);
    const hub = config
      ? (
          this.opts.build ??
          ((c) => buildHub(c, this.opts.paths, this.opts.secretStore))
        )(config)
      : null;
    const scope = scopeForAgent(
      this.opts.paths.orgConfigPath,
      this.agentId,
      onError,
      config ?? { servers: {} },
    );

    const previous = this.current;
    this.current = { hub, inFlight: 0, retired: false };
    this.currentScope = scope;
    previous.retired = true;
    if (previous.hub && previous.inFlight === 0) void previous.hub.close();

    // What the agent can see: the enabled servers it may use, and their
    // tool rules. Anything else (a comment, another agent's access) does
    // not warrant a list_changed.
    const view = canonicalJson(
      config
        ? Object.entries(config.servers)
            .filter(
              ([name, s]) =>
                s.enabled &&
                (!scope.allowedServers || scope.allowedServers.has(name)),
            )
            .map(([name, s]) => [
              name,
              s.tools,
              s.url ?? null,
              s.command ?? null,
              s.args,
            ])
        : [],
    );
    const changed = view !== this.viewKey;
    this.viewKey = view;
    if (changed && !quiet) this.opts.onToolsChanged?.();
  }
}

/** mtime + size + inode: an atomic rename changes the inode even when a
 *  quick edit keeps the mtime and size. */
function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "missing";
  }
}
