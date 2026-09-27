import {
  HubConfigSchema,
  referencedSecrets,
  SERVER_NAME_RE,
  type HubConfig,
  type HubMode,
  type ServerConfigInput,
} from "./config.js";
import { findCatalogEntry, serverConfigFromCatalog, type McpCatalog } from "./catalog.js";

// Pure mcp.yaml edits behind `foreman mcp add / remove / enable / mode`.
// Each returns a new, schema-validated config so the CLI only does I/O.

export class HubConfigEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubConfigEditError";
  }
}

export interface AddServerInput {
  /** Catalog id, or the name of a custom server. */
  id: string;
  /** Name in mcp.yaml (defaults to `id`). */
  name?: string;
  /** Extra positional args appended to the catalog command. */
  extraArgs?: readonly string[];
  /** Custom stdio server. */
  command?: string;
  /** Custom streamable-HTTP server. */
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  force?: boolean;
}

export function addServer(config: HubConfig, catalog: McpCatalog, input: AddServerInput): HubConfig {
  const name = input.name ?? input.id;
  if (!SERVER_NAME_RE.test(name)) {
    throw new HubConfigEditError(
      `'${name}' is not a valid server name — lowercase letters, digits and '-' (max 32 chars)`,
    );
  }
  if (config.servers[name] && !input.force) {
    throw new HubConfigEditError(`server '${name}' already exists — pass --force to replace it`);
  }
  let server: ServerConfigInput;
  if (input.command || input.url) {
    server = {
      enabled: true,
      ...(input.command ? { command: input.command, args: [...(input.extraArgs ?? [])] } : {}),
      ...(input.url ? { url: input.url } : {}),
    };
  } else {
    const entry = findCatalogEntry(catalog, input.id);
    if (!entry) {
      throw new HubConfigEditError(
        `'${input.id}' is not in the catalog — run \`foreman mcp catalog\`, or add a custom server with --command / --url`,
      );
    }
    if (entry.user_args && (input.extraArgs ?? []).length === 0) {
      throw new HubConfigEditError(
        `${entry.name} needs: ${entry.user_args.description}\n  e.g. foreman mcp add ${entry.id} ${entry.user_args.example.join(" ")}`,
      );
    }
    server = serverConfigFromCatalog(entry, input.extraArgs ?? []);
  }
  if (input.env) server.env = { ...(server.env ?? {}), ...input.env };
  if (input.headers) server.headers = { ...(server.headers ?? {}), ...input.headers };
  return HubConfigSchema.parse({ ...config, servers: { ...config.servers, [name]: server } });
}

export function removeServer(config: HubConfig, name: string): HubConfig {
  if (!config.servers[name]) throw new HubConfigEditError(`no server named '${name}' in mcp.yaml`);
  const servers = { ...config.servers };
  delete servers[name];
  return HubConfigSchema.parse({ ...config, servers });
}

export function setServerEnabled(config: HubConfig, name: string, enabled: boolean): HubConfig {
  const server = config.servers[name];
  if (!server) throw new HubConfigEditError(`no server named '${name}' in mcp.yaml`);
  return HubConfigSchema.parse({ ...config, servers: { ...config.servers, [name]: { ...server, enabled } } });
}

export function setMode(config: HubConfig, mode: HubMode): HubConfig {
  return HubConfigSchema.parse({ ...config, mode });
}

/** Secrets a server references that are not in the secret store yet. */
export function missingSecrets(
  config: HubConfig,
  name: string,
  exists: (secretName: string) => boolean,
): string[] {
  const server = config.servers[name];
  if (!server) return [];
  return referencedSecrets(server).filter((s) => !exists(s));
}
