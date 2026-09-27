import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthMetadataSchema, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { withLockFile } from "./oauth-lock.js";
import {
  assertSecureEndpoint,
  describeOAuthFailure,
  hardenedOAuthFetch,
  isInvalidGrant,
  McpOAuthError,
  McpOAuthRequiredError,
} from "./oauth-http.js";
import {
  clearMcpOAuthRecord,
  isExpiring,
  loadMcpOAuthRecord,
  recordSecretValues,
  replaceMcpOAuthRecordIfUnchanged,
  saveMcpOAuthRecord,
  type McpOAuthRecord,
  type McpOAuthSecretStore,
} from "./oauth-store.js";

// =============================================================================
// Hub-side OAuth session for one upstream server
// =============================================================================
//
// Lives only in the hub process. It hands out a valid access token —
// refreshing shortly before expiry, or once after the upstream answers 401 —
// and wraps the transport's fetch so every request to the server carries
// `Authorization: Bearer …`. Agents never see the token: it is added after
// mediation, on the hub's own connection.
//
// The stored session is re-read on every use, so a `foreman mcp logout`
// takes effect on the next request of a running hub. Every write to it
// (refresh, login, logout, remove) runs under one cross-process lock
// (oauth-lock), and a refresh only replaces the exact session it started
// from: a rotated refresh token is never presented twice, and a logout or
// re-login during a refresh is never undone.

export interface McpOAuthSessionOptions {
  server: string;
  /** The URL from mcp.yaml; the stored session must have been issued for it. */
  serverUrl: string;
  store: McpOAuthSecretStore;
  /** Cross-process session lock; `null` = in-process only (tests). */
  lockPath: string | null;
  /** Upstream fetch (MCP requests and token refresh). */
  fetchFn?: FetchLike;
  now?: () => number;
}

export class McpOAuthSession {
  private refreshing: Promise<McpOAuthRecord> | null = null;
  private readonly baseFetch: FetchLike;
  private readonly now: () => number;
  private touched = false;
  /** Every token value this session has held, for scrubbing. */
  private readonly seen = new Set<string>();

  constructor(private readonly opts: McpOAuthSessionOptions) {
    this.baseFetch = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** A usable access token. `rejected` is a token the server just refused:
   *  if it is still the current one, it is refreshed rather than reused. */
  async accessToken(opts: { rejected?: string } = {}): Promise<string> {
    const record = this.load();
    const stale = opts.rejected !== undefined && record.tokens.access_token === opts.rejected;
    if (!stale && !isExpiring(record, this.now())) return record.tokens.access_token;
    if (!this.refreshing) {
      this.refreshing = this.refresh(record.tokens.access_token).finally(() => {
        this.refreshing = null;
      });
    }
    return (await this.refreshing).tokens.access_token;
  }

  /** Token values to mask in any text leaving the hub. */
  knownSecrets(): string[] {
    return [...this.seen];
  }

  /** Fetch for the upstream transport: attaches the bearer token, and on a
   *  401 refreshes once and retries. Requests to any other origin, and
   *  redirects (same-origin included), are refused, so the token only ever
   *  reaches the server it was issued for. */
  readonly fetch: FetchLike = async (url, init) => {
    const target = new URL(url instanceof URL ? url.href : url);
    if (target.origin !== new URL(this.opts.serverUrl).origin) {
      throw new McpOAuthError(`refusing to send '${this.opts.server}' credentials to ${target.origin}`);
    }
    const token = await this.accessToken();
    const first = await this.send(url, init, token);
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => undefined);
    const fresh = await this.accessToken({ rejected: token });
    const second = await this.send(url, init, fresh);
    if (second.status === 401) {
      await second.body?.cancel().catch(() => undefined);
      throw new McpOAuthRequiredError(this.opts.server, "the server rejected a freshly refreshed token");
    }
    return second;
  };

  private async send(url: string | URL, init: RequestInit | undefined, token: string): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const res = await this.baseFetch(url, { ...init, headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new McpOAuthError(
        `MCP server '${this.opts.server}' answered with a redirect (HTTP ${res.status}); Foreman does not follow redirects with credentials — update its url in mcp.yaml`,
      );
    }
    return res;
  }

  private load(): McpOAuthRecord {
    const record = loadMcpOAuthRecord(this.opts.store, this.opts.server, { touch: !this.touched });
    this.touched = true;
    if (!record) throw new McpOAuthRequiredError(this.opts.server, "not logged in");
    if (record.server_url !== this.opts.serverUrl) {
      throw new McpOAuthRequiredError(this.opts.server, "the server URL in mcp.yaml changed since login");
    }
    if (record.needs_login) throw new McpOAuthRequiredError(this.opts.server, record.needs_login);
    for (const v of recordSecretValues(record)) this.seen.add(v);
    return record;
  }

  private async refresh(heldAccessToken: string): Promise<McpOAuthRecord> {
    return withSessionLock(this.opts.lockPath, async () => {
      // Another process may have refreshed (and rotated) while we waited.
      const latest = this.load();
      if (latest.tokens.access_token !== heldAccessToken && !isExpiring(latest, this.now())) return latest;
      const refreshToken = latest.tokens.refresh_token;
      if (!refreshToken) {
        throw new McpOAuthRequiredError(this.opts.server, "the access token expired and there is no refresh token");
      }
      const metadata = OAuthMetadataSchema.safeParse(latest.metadata);
      if (!metadata.success) {
        throw new McpOAuthRequiredError(this.opts.server, "stored authorization-server metadata is unreadable");
      }
      assertSecureEndpoint(metadata.data.token_endpoint, "token endpoint");
      let tokens: OAuthTokens;
      try {
        tokens = await refreshAuthorization(latest.authorization_server_url, {
          metadata: metadata.data,
          clientInformation: latest.client,
          refreshToken,
          ...(latest.resource ? { resource: new URL(latest.resource) } : {}),
          fetchFn: hardenedOAuthFetch(this.baseFetch),
        });
      } catch (err) {
        if (isInvalidGrant(err)) {
          const reason = "the authorization server refused the refresh token";
          replaceMcpOAuthRecordIfUnchanged(this.opts.store, latest, { ...latest, needs_login: reason });
          throw new McpOAuthRequiredError(this.opts.server, reason);
        }
        throw new McpOAuthError(
          `token refresh for '${this.opts.server}' failed: ${describeOAuthFailure(err, [...this.seen, refreshToken])}`,
        );
      }
      const obtainedAt = this.now();
      const next: McpOAuthRecord = {
        ...latest,
        tokens: {
          access_token: tokens.access_token,
          token_type: tokens.token_type,
          // refreshAuthorization keeps the old refresh token when the server
          // did not rotate it; a rotated one replaces it here.
          ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
          ...(tokens.scope ? { scope: tokens.scope } : latest.tokens.scope ? { scope: latest.tokens.scope } : {}),
        },
        expires_at: tokens.expires_in !== undefined ? obtainedAt + tokens.expires_in * 1000 : null,
        obtained_at: obtainedAt,
      };
      for (const v of recordSecretValues(next)) this.seen.add(v);
      // Persist before use, and only over the session we refreshed: a
      // logout or new login in the meantime wins.
      if (!replaceMcpOAuthRecordIfUnchanged(this.opts.store, latest, next)) return this.load();
      return next;
    });
  }
}

export function withSessionLock<T>(lockPath: string | null, fn: () => Promise<T>): Promise<T> {
  return lockPath ? withLockFile(lockPath, fn) : fn();
}

/** Store a completed login under the session lock. */
export async function storeMcpOAuthLogin(
  store: McpOAuthSecretStore,
  record: McpOAuthRecord,
  lockPath: string | null,
): Promise<void> {
  await withSessionLock(lockPath, async () => saveMcpOAuthRecord(store, record));
}

/** Delete a session under the session lock. Returns the removed session
 *  (for revocation), or null when there was none or it was unreadable. */
export async function removeMcpOAuthSession(
  store: McpOAuthSecretStore,
  server: string,
  lockPath: string | null,
): Promise<{ removed: boolean; record: McpOAuthRecord | null }> {
  return withSessionLock(lockPath, async () => {
    let record: McpOAuthRecord | null = null;
    try {
      record = loadMcpOAuthRecord(store, server);
    } catch {
      // corrupt: delete it all the same
    }
    return { removed: clearMcpOAuthRecord(store, server), record };
  });
}

export interface RevocationResult {
  revoked: boolean;
  detail: string;
}

/** Best-effort RFC 7009 revocation of a removed session's tokens. Never
 *  throws: logout has already deleted the local copy. */
export async function revokeMcpOAuthTokens(
  record: McpOAuthRecord,
  fetchFn?: FetchLike,
): Promise<RevocationResult> {
  const endpoint = record.metadata["revocation_endpoint"];
  if (typeof endpoint !== "string") {
    return { revoked: false, detail: "the server does not offer token revocation" };
  }
  const secrets = recordSecretValues(record);
  try {
    assertSecureEndpoint(endpoint, "revocation endpoint");
    const post = hardenedOAuthFetch(fetchFn);
    const pairs: Array<[string | undefined, string]> = [
      [record.tokens.refresh_token, "refresh_token"],
      [record.tokens.access_token, "access_token"],
    ];
    for (const [token, hint] of pairs) {
      if (!token) continue;
      const body = new URLSearchParams({ token, token_type_hint: hint });
      const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
      if (record.client.client_secret) {
        headers.set(
          "Authorization",
          `Basic ${Buffer.from(`${record.client.client_id}:${record.client.client_secret}`).toString("base64")}`,
        );
      } else {
        body.set("client_id", record.client.client_id);
      }
      const res = await post(endpoint, { method: "POST", headers, body });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) return { revoked: false, detail: `the revocation endpoint answered HTTP ${res.status}` };
    }
    return { revoked: true, detail: "revoked at the provider" };
  } catch (err) {
    return { revoked: false, detail: describeOAuthFailure(err, secrets) };
  }
}
