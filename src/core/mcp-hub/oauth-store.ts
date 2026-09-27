import { z } from "zod";
import { SecretNotFoundError, type SecretStore } from "../secret-store.js";
import { mcpOAuthSecretName } from "./config.js";

// =============================================================================
// Hub OAuth sessions in the encrypted secret store
// =============================================================================
//
// One secret per mcp.yaml server (`mcp-oauth-<name>`) holds everything the
// hub needs to keep a hosted server authorised without the user: the
// registered client, the authorization server's metadata, and the token
// pair. The whole bundle is written in one statement, so an access token and
// the refresh token that came with it are never persisted apart.

export type McpOAuthSecretStore = Pick<SecretStore, "exists" | "get" | "add" | "rotate" | "remove">;

const TokensSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .strip();

const ClientSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
    token_endpoint_auth_method: z.string().optional(),
  })
  .strip();

export const McpOAuthRecordSchema = z
  .object({
    version: z.literal(1),
    server: z.string().min(1),
    /** The mcp.yaml URL the tokens were issued for. A token is only ever
     *  sent to this exact URL. */
    server_url: z.string().url(),
    authorization_server_url: z.string().url(),
    /** RFC 9728 / RFC 8707 resource indicator, when the server published one. */
    resource: z.string().url().optional(),
    scope: z.string().optional(),
    /** RFC 8414 metadata as discovered at login (validated again on use). */
    metadata: z.record(z.string(), z.unknown()),
    client: ClientSchema,
    redirect_uri: z.string().url(),
    tokens: TokensSchema,
    /** Epoch ms; null when the server did not say. */
    expires_at: z.number().nullable(),
    obtained_at: z.number(),
    /** Set when a refresh was refused — the user has to log in again. */
    needs_login: z.string().optional(),
  })
  .strip();

export type McpOAuthRecord = z.infer<typeof McpOAuthRecordSchema>;

export class McpOAuthRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthRecordError";
  }
}

/** `touch: true` records an access on the secret; status reads and the
 *  hub's per-request re-check leave it alone. */
export function loadMcpOAuthRecord(
  store: Pick<SecretStore, "get">,
  server: string,
  opts: { touch?: boolean } = {},
): McpOAuthRecord | null {
  let json: string;
  try {
    json = store.get(mcpOAuthSecretName(server), { touch: opts.touch === true });
  } catch (err) {
    if (err instanceof SecretNotFoundError) return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new McpOAuthRecordError(`stored OAuth session for '${server}' is corrupt — run \`foreman mcp login ${server}\``);
  }
  const parsed = McpOAuthRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new McpOAuthRecordError(
      `stored OAuth session for '${server}' is unreadable — run \`foreman mcp login ${server}\``,
    );
  }
  return parsed.data;
}

/** Store a new login: replace the server's whole bundle in one write. */
export function saveMcpOAuthRecord(store: McpOAuthSecretStore, record: McpOAuthRecord): void {
  const name = mcpOAuthSecretName(record.server);
  const json = JSON.stringify(McpOAuthRecordSchema.parse(record));
  if (store.exists(name)) store.rotate(name, json);
  else store.add(name, json);
}

/** Replace the bundle only if the stored one is still `expected` (same login
 *  and token pair). Never creates one: a session removed meanwhile (logout)
 *  stays removed. Returns whether it wrote. */
export function replaceMcpOAuthRecordIfUnchanged(
  store: McpOAuthSecretStore,
  expected: McpOAuthRecord,
  next: McpOAuthRecord,
): boolean {
  let current: McpOAuthRecord | null;
  try {
    current = loadMcpOAuthRecord(store, expected.server);
  } catch {
    return false;
  }
  if (!current || !sameSession(current, expected)) return false;
  store.rotate(mcpOAuthSecretName(next.server), JSON.stringify(McpOAuthRecordSchema.parse(next)));
  return true;
}

function sameSession(a: McpOAuthRecord, b: McpOAuthRecord): boolean {
  return (
    a.obtained_at === b.obtained_at &&
    a.tokens.access_token === b.tokens.access_token &&
    a.tokens.refresh_token === b.tokens.refresh_token &&
    a.client.client_id === b.client.client_id
  );
}

/** Returns whether a session existed. */
export function clearMcpOAuthRecord(store: McpOAuthSecretStore, server: string): boolean {
  const name = mcpOAuthSecretName(server);
  if (!store.exists(name)) return false;
  store.remove(name);
  return true;
}

/** Every token-like value in a record, for scrubbing error text. */
export function recordSecretValues(record: McpOAuthRecord | null): string[] {
  if (!record) return [];
  return [record.tokens.access_token, record.tokens.refresh_token, record.client.client_secret].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

// -----------------------------------------------------------------------------
// Status (no network: `foreman mcp list` and `doctor` read only the store)
// -----------------------------------------------------------------------------

/** Refresh up to this long before the stated expiry… */
export const EXPIRY_SKEW_MS = 60_000;
/** …but never within this long of obtaining the token. */
const JUST_OBTAINED_MS = 5_000;

export type McpOAuthStatus =
  | { state: "logged-in"; expiresAt: number | null }
  | { state: "expired"; expiresAt: number }
  | { state: "needs-login"; reason: string };

/** Due for a refresh: within min(60 s, half its lifetime) of expiry. A
 *  short-lived token (say 30 s) is therefore used for half its life instead
 *  of being refreshed on every request. */
export function isExpiring(record: McpOAuthRecord, now: number): boolean {
  if (record.expires_at === null) return false;
  if (now - record.obtained_at < JUST_OBTAINED_MS) return false;
  const lifetime = Math.max(0, record.expires_at - record.obtained_at);
  const skew = Math.min(EXPIRY_SKEW_MS, lifetime / 2);
  return now >= record.expires_at - skew;
}

export function mcpOAuthStatus(
  store: Pick<SecretStore, "get">,
  server: string,
  serverUrl: string | undefined,
  now: number = Date.now(),
): McpOAuthStatus {
  let record: McpOAuthRecord | null;
  try {
    record = loadMcpOAuthRecord(store, server);
  } catch (err) {
    return { state: "needs-login", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!record) return { state: "needs-login", reason: "not logged in" };
  if (record.server_url !== serverUrl) {
    return { state: "needs-login", reason: "the server URL changed since login" };
  }
  if (record.needs_login) return { state: "needs-login", reason: record.needs_login };
  if (isExpiring(record, now)) {
    if (!record.tokens.refresh_token) {
      return { state: "needs-login", reason: "token expired and the server issued no refresh token" };
    }
    return { state: "expired", expiresAt: record.expires_at! };
  }
  return { state: "logged-in", expiresAt: record.expires_at };
}

export function describeMcpOAuthStatus(
  server: string,
  status: McpOAuthStatus,
  now: number = Date.now(),
): string {
  switch (status.state) {
    case "logged-in":
      return status.expiresAt === null
        ? "logged in"
        : `logged in · expires in ${formatDuration(status.expiresAt - now)}`;
    case "expired":
      return "logged in · token expired, refreshes on next use";
    case "needs-login":
      return `needs login (${status.reason}) — run \`foreman mcp login ${server}\``;
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
