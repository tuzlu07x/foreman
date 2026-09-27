import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthMetadataSchema, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  describeOAuthFailure,
  hardenedOAuthFetch,
  isInvalidGrant,
  McpOAuthError,
  McpOAuthRequiredError,
} from "./oauth-http.js";
import {
  isExpiring,
  loadMcpOAuthRecord,
  recordSecretValues,
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
// Refresh-token rotation: several `foreman mcp-stdio` processes (one per
// agent) share one stored session. A refresh runs under a lock file, re-reads
// the store first (another process may already have rotated the pair), and
// persists the new access + refresh token in a single write before using
// them. A rotated-away refresh token is therefore never presented twice.

export interface McpOAuthSessionOptions {
  server: string;
  /** The URL from mcp.yaml; the stored session must have been issued for it. */
  serverUrl: string;
  store: McpOAuthSecretStore;
  /** Cross-process refresh lock; `null` = in-process only (tests). */
  lockPath: string | null;
  /** Upstream fetch (MCP requests and token refresh). */
  fetchFn?: FetchLike;
  now?: () => number;
}

const LOCK_WAIT_MS = 20_000;
const LOCK_STALE_MS = 60_000;

export class McpOAuthSession {
  private record: McpOAuthRecord | null = null;
  private refreshing: Promise<McpOAuthRecord> | null = null;
  private readonly baseFetch: FetchLike;
  private readonly now: () => number;
  /** Every token value this session has held, for error scrubbing. */
  private readonly seen = new Set<string>();

  constructor(private readonly opts: McpOAuthSessionOptions) {
    this.baseFetch = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** A usable access token. `rejected` is a token the server just refused:
   *  if it is still the current one, it is refreshed rather than reused. */
  async accessToken(opts: { rejected?: string } = {}): Promise<string> {
    const record = this.current();
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
   *  401 refreshes once and retries. Requests to any other origin are
   *  refused, so the token can only ever reach the server it was issued for. */
  readonly fetch: FetchLike = async (url, init) => {
    const target = new URL(url instanceof URL ? url.href : url);
    if (target.origin !== new URL(this.opts.serverUrl).origin) {
      throw new McpOAuthError(`refusing to send '${this.opts.server}' credentials to ${target.origin}`);
    }
    const token = await this.accessToken();
    const first = await this.baseFetch(url, withBearer(init, token));
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => undefined);
    const fresh = await this.accessToken({ rejected: token });
    const second = await this.baseFetch(url, withBearer(init, fresh));
    if (second.status === 401) {
      await second.body?.cancel().catch(() => undefined);
      throw new McpOAuthRequiredError(this.opts.server, "the server rejected a freshly refreshed token");
    }
    return second;
  };

  private current(): McpOAuthRecord {
    const record = this.record ?? this.load();
    this.record = record;
    return record;
  }

  private load(): McpOAuthRecord {
    const record = loadMcpOAuthRecord(this.opts.store, this.opts.server);
    if (!record) throw new McpOAuthRequiredError(this.opts.server, "not logged in");
    if (record.server_url !== this.opts.serverUrl) {
      throw new McpOAuthRequiredError(this.opts.server, "the server URL in mcp.yaml changed since login");
    }
    if (record.needs_login) throw new McpOAuthRequiredError(this.opts.server, record.needs_login);
    for (const v of recordSecretValues(record)) this.seen.add(v);
    return record;
  }

  private async refresh(heldAccessToken: string): Promise<McpOAuthRecord> {
    return withLockFile(this.opts.lockPath, async () => {
      // Another process may have refreshed (and rotated) while we waited.
      const latest = this.load();
      if (latest.tokens.access_token !== heldAccessToken && !isExpiring(latest, this.now())) {
        this.record = latest;
        return latest;
      }
      const refreshToken = latest.tokens.refresh_token;
      if (!refreshToken) {
        throw new McpOAuthRequiredError(this.opts.server, "the access token expired and there is no refresh token");
      }
      const metadata = OAuthMetadataSchema.safeParse(latest.metadata);
      if (!metadata.success) {
        throw new McpOAuthRequiredError(this.opts.server, "stored authorization-server metadata is unreadable");
      }
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
          saveMcpOAuthRecord(this.opts.store, { ...latest, needs_login: reason });
          this.record = null;
          throw new McpOAuthRequiredError(this.opts.server, reason);
        }
        throw new McpOAuthError(
          `token refresh for '${this.opts.server}' failed: ${describeOAuthFailure(err, [
            ...this.seen,
            refreshToken,
          ])}`,
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
      // Persist before use: if this process dies now, the rotated refresh
      // token is not lost.
      saveMcpOAuthRecord(this.opts.store, next);
      this.record = next;
      return next;
    });
  }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** Exclusive-create lock file with a stale-lock breaker. */
async function withLockFile<T>(path: string | null, fn: () => Promise<T>): Promise<T> {
  if (!path) return fn();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new McpOAuthError("timed out waiting for another Foreman process to finish a token refresh");
      }
      await delay(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
