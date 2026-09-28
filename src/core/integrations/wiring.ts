import { hubOAuthSessions, mcpOAuthLockPath } from "../mcp-hub/boot.js";
import { loadBundledMcpCatalog, type McpCatalog } from "../mcp-hub/catalog.js";
import { McpHub } from "../mcp-hub/hub.js";
import { runMcpOAuthLogin } from "../mcp-hub/oauth-login.js";
import { removeMcpOAuthSession, revokeMcpOAuthTokens, storeMcpOAuthLogin } from "../mcp-hub/oauth-session.js";
import { ToolPinStore } from "../mcp-hub/pins.js";
import { loadBundledRegistry } from "../registry-catalog.js";
import type { SecretStore } from "../secret-store.js";
import { loadBundledIntegrationCatalog, type IntegrationCatalog } from "./catalog.js";
import { IntegrationService, type IntegrationAuditSink } from "./service.js";
import type { HubFactory } from "./verify.js";

// One place that builds an IntegrationService and the private review hub,
// for the CLI (`foreman integrations`) and the TUI Integrations page.

export interface IntegrationPaths {
  mcpConfigPath: string;
  mcpPinsPath: string;
}

export interface IntegrationWiring {
  service: IntegrationService;
  catalogs: { mcp: McpCatalog; integrations: IntegrationCatalog };
  /** A private hub for review / test (never shown to agents). */
  makeHub: HubFactory;
  /** Browser sign-in for an OAuth integration; `onUrl` shows the link. */
  signIn: (server: string, url: string, onUrl: (url: string) => void) => Promise<void>;
}

/** The bundled catalogs, cross-validated against agents.json. */
export function loadIntegrationCatalogs(): { mcp: McpCatalog; integrations: IntegrationCatalog } {
  const mcp = loadBundledMcpCatalog();
  const integrations = loadBundledIntegrationCatalog({
    mcp,
    agentIds: new Set(loadBundledRegistry().agents.map((a) => a.id)),
  });
  return { mcp, integrations };
}

export function createIntegrationWiring(opts: {
  paths: IntegrationPaths;
  store: SecretStore;
  audit: IntegrationAuditSink;
  catalogs?: { mcp: McpCatalog; integrations: IntegrationCatalog };
}): IntegrationWiring {
  const { paths, store } = opts;
  const catalogs = opts.catalogs ?? loadIntegrationCatalogs();
  const service = new IntegrationService({
    paths,
    mcpCatalog: catalogs.mcp,
    integrationCatalog: catalogs.integrations,
    secrets: store,
    // Read the pin file on every check: a review writes it through another
    // ToolPinStore (the review hub), and a snapshot would still say "not
    // reviewed" right after it.
    pins: {
      get: (server, fingerprint) => new ToolPinStore(paths.mcpPinsPath).get(server, fingerprint),
      forget: (server) => new ToolPinStore(paths.mcpPinsPath).forget(server),
    },
    audit: opts.audit,
    removeOAuthSession: async (server) => {
      const removed = await removeMcpOAuthSession(store, server, mcpOAuthLockPath(paths, server));
      if (removed.record) await revokeMcpOAuthTokens(removed.record).catch(() => undefined);
      return removed.removed;
    },
  });
  const makeHub: HubFactory = ({ config }) =>
    new McpHub({
      config,
      resolveSecret: (n) => (store.exists(n) ? store.get(n) : null),
      pins: new ToolPinStore(config.security.pin_tool_definitions ? paths.mcpPinsPath : null),
      oauth: hubOAuthSessions(paths, store),
    });
  const signIn = async (server: string, url: string, onUrl: (url: string) => void): Promise<void> => {
    const record = await runMcpOAuthLogin({ server, serverUrl: url, presentAuthUrl: onUrl });
    await storeMcpOAuthLogin(store, record, mcpOAuthLockPath(paths, server));
  };
  return { service, catalogs, makeHub, signIn };
}
