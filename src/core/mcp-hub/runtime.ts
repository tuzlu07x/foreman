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
// HubRuntime — the hub a connected agent uses, kept current
// =============================================================================
//
// `foreman integrations disable jira` (or any edit of mcp.yaml / org.yaml)
// must reach agents that are already connected, not only the next ones.
// Before every hub listing or call, sync() stats both files (at most once a
// second): when mcp.yaml changed the hub is rebuilt, and when either
// changed the agent's scope is recomputed from the files as they are now.
// A file that no longer parses means no hub servers at all (fail closed),
// never the last good copy.
//
// The hub itself lives in a SharedHub: one per `foreman mcp-stdio`, or one
// for every agent connected to the daemon (#616), so each upstream server
// runs once. The scope stays per agent. A replaced hub keeps serving the
// calls already running on it and is closed when the last one finishes.

export interface SharedHubOptions {
  paths: HubPaths;
  secretStore: McpOAuthSecretStore;
  onError?: (message: string) => void;
  /** Tests: build the hub from a config. */
  build?: (config: HubConfig) => McpHub | null;
}

interface Generation {
  id: number;
  config: HubConfig | null;
  hub: McpHub | null;
  inFlight: number;
  retired: boolean;
}

/** The hub built from mcp.yaml, rebuilt when the file changes. */
export class SharedHub {
  private current: Generation = {
    id: 0,
    config: null,
    hub: null,
    inFlight: 0,
    retired: false,
  };
  private signature: string | null = null;
  private pinsSignature: string | null = null;
  private closed = false;

  constructor(private readonly opts: SharedHubOptions) {}

  get generation(): Readonly<Pick<Generation, "id" | "config" | "hub">> {
    return this.current;
  }

  /** Rebuild when mcp.yaml changed since the last look. */
  sync(): void {
    if (this.closed) return;
    const signature = fileSignature(this.opts.paths.mcpConfigPath);
    if (signature === this.signature) return;
    this.signature = signature;
    const onError = this.opts.onError ?? (() => undefined);
    const config = readHubConfigOrNull(this.opts.paths, onError);
    const hub = config
      ? (
          this.opts.build ??
          ((c) => buildHub(c, this.opts.paths, this.opts.secretStore))
        )(config)
      : null;
    const previous = this.current;
    this.current = {
      id: previous.id + 1,
      config,
      hub,
      inFlight: 0,
      retired: false,
    };
    this.pinsSignature = fileSignature(this.opts.paths.mcpPinsPath);
    previous.retired = true;
    if (previous.hub && previous.inFlight === 0) void previous.hub.close();
  }

  /** A new agent session starts on the daemon: the tool pins are read
   *  again and every listing is re-verified against the live server before
   *  its next call, as in a freshly started `foreman mcp-stdio`. The
   *  upstream servers keep running. */
  beginSession(): void {
    this.sync();
    this.current.hub?.resetSession?.();
    this.pinsSignature = fileSignature(this.opts.paths.mcpPinsPath);
  }

  /** Another process rewrote the pins (`foreman mcp trust`, a drift found
   *  by `foreman mcp tools --refresh`): use them from the next listing or
   *  call on. */
  syncPins(): void {
    if (this.closed) return;
    const pins = fileSignature(this.opts.paths.mcpPinsPath);
    if (pins === this.pinsSignature) return;
    this.pinsSignature = pins;
    this.current.hub?.resetSession?.();
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
    this.closed = true;
    const gen = this.current;
    this.current = {
      id: gen.id + 1,
      config: null,
      hub: null,
      inFlight: 0,
      retired: false,
    };
    gen.retired = true;
    if (gen.hub && gen.inFlight === 0) await gen.hub.close();
  }
}

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
  /** The daemon's hub, shared by every agent. Without it the runtime
   *  builds and owns its own. */
  shared?: SharedHub;
}

export class HubRuntime {
  private readonly shared: SharedHub;
  private readonly ownsShared: boolean;
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
    this.ownsShared = opts.shared === undefined;
    this.shared =
      opts.shared ??
      new SharedHub({
        paths: opts.paths,
        secretStore: opts.secretStore,
        ...(opts.onError ? { onError: opts.onError } : {}),
        ...(opts.build ? { build: opts.build } : {}),
      });
    this.sync({ force: true, quiet: true });
  }

  get hub(): McpHub | null {
    return this.shared.generation.hub;
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

  /** Follow mcp.yaml and org.yaml. `force` skips the throttle (used right
   *  before a call runs). */
  sync(opts: { force?: boolean; quiet?: boolean } = {}): void {
    const now = this.now();
    if (!opts.force && now - this.lastCheck < this.throttleMs) return;
    this.lastCheck = now;
    this.shared.sync();
    if (!this.ownsShared) this.shared.syncPins();
    const gen = this.shared.generation;
    const signature = `${this.agentId}\u0000${gen.id}\u0000${fileSignature(this.opts.paths.orgConfigPath)}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.rescope(gen.config, opts.quiet === true);
  }

  /** Run `fn` on the current hub, keeping that hub open until it returns. */
  run<T>(fn: (hub: McpHub) => Promise<T>): Promise<T> {
    return this.shared.run(fn);
  }

  /** Close the hub this runtime owns; a shared hub stays up. */
  async close(): Promise<void> {
    if (this.ownsShared) await this.shared.close();
  }

  private rescope(config: HubConfig | null, quiet: boolean): void {
    const onError = this.opts.onError ?? (() => undefined);
    const scope = scopeForAgent(
      this.opts.paths.orgConfigPath,
      this.agentId,
      onError,
      config ?? { servers: {} },
    );
    this.currentScope = scope;

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
