import { OAuthError as SdkOAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { redactSecretShapes } from "../risk-rules/secret-patterns.js";

// Shared plumbing for the hub's MCP OAuth client: error types, the endpoint
// rule (https, or plain http on loopback only), a fetch that never follows a
// redirect with a credential in the body, and error-text scrubbing.

export class McpOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthError";
  }
}

/** The server has no usable session: the user must run `foreman mcp login`. */
export class McpOAuthRequiredError extends McpOAuthError {
  constructor(
    public readonly server: string,
    public readonly reason: string,
  ) {
    super(`MCP server '${server}' needs OAuth login (${reason}) — run \`foreman mcp login ${server}\``);
    this.name = "McpOAuthRequiredError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** https everywhere; plain http only for a server on this machine. */
export function assertSecureEndpoint(raw: string | URL | undefined, what: string): URL {
  if (raw === undefined) throw new McpOAuthError(`the authorization server did not publish its ${what}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpOAuthError(`the ${what} is not a valid URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new McpOAuthError(
    `refusing a non-https ${what} (${url.protocol}//${url.host}) — only loopback may use plain http`,
  );
}

/** Shorter than the session lock's stale threshold (oauth-lock). */
export const OAUTH_HTTP_TIMEOUT_MS = 15_000;

/** Every OAuth request goes to an https (or loopback) URL. Discovery GETs
 *  may follow redirects (to https / loopback targets only); anything
 *  carrying a code, verifier or token (POST) must not be replayed to another
 *  location, so redirects there are an error. */
export function hardenedOAuthFetch(base: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    assertSecureEndpoint(url, "OAuth endpoint");
    const method = (init?.method ?? "GET").toUpperCase();
    const res = await base(url, {
      ...init,
      redirect: method === "GET" ? "follow" : "error",
      signal: init?.signal ?? AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    });
    if (res.redirected) assertSecureEndpoint(res.url, "redirect target");
    return res;
  };
}

const MAX_ERROR_CHARS = 300;

/** Error text safe to print, log or audit: every value in `secrets` is
 *  masked, as is anything credential-shaped, and upstream prose is clipped. */
export function scrubOAuthText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const value of secrets) {
    if (value.length >= 4) out = out.split(value).join("[redacted]");
  }
  out = redactSecretShapes(out).text;
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS)}…` : out;
}

export function describeOAuthFailure(err: unknown, secrets: readonly string[]): string {
  let text: string;
  if (err instanceof SdkOAuthError) {
    text = err.message ? `${err.errorCode}: ${err.message}` : err.errorCode;
  } else if (err instanceof Error) {
    text = err.name === "TimeoutError" ? "the request timed out" : err.message;
  } else {
    text = String(err);
  }
  return scrubOAuthText(text, secrets);
}

export function isInvalidGrant(err: unknown): boolean {
  return err instanceof SdkOAuthError && (err.errorCode === "invalid_grant" || err.errorCode === "invalid_client");
}
