import { createServer } from "node:http";
import type { OAuthProviderConfig } from "./oauth-providers.js";

export interface OAuthFetch {
  (
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** The client id issued for this sign-in. */
  clientId?: string;
  /** Granted scopes, space-separated. */
  scope?: string;
  idToken?: string;
  /** The verified account. */
  sub?: string;
  email?: string;
}

/** What the browser hands back. */
export interface OAuthCallback {
  code: string;
  state?: string;
  /** Issued on a first registration. */
  clientId?: string;
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

const EXPIRY_SAFETY_MS = 5 * 60 * 1000;

const defaultFetch: OAuthFetch = (url, init) => fetch(url, init) as never;

export function buildAuthorizeUrl(
  provider: OAuthProviderConfig,
  challenge: string,
  state: string,
  extra: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", provider.redirectUri);
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries({ ...provider.extraAuthorizeParams, ...extra })) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export function parseCallbackInput(input: string): OAuthCallback {
  const trimmed = input.trim();
  if (trimmed === "") throw new OAuthError("Empty authorization input");

  if (/^https?:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const code = u.searchParams.get("code");
    if (!code) throw new OAuthError("No `code` parameter in the pasted URL");
    return callbackOf(code, u.searchParams);
  }
  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#");
    if (!code) throw new OAuthError('No code before the "#"');
    return { code, state: state || undefined };
  }
  if (trimmed.includes("=")) {
    const params = new URLSearchParams(trimmed);
    const code = params.get("code");
    if (code) return callbackOf(code, params);
  }
  return { code: trimmed };
}

function callbackOf(code: string, params: URLSearchParams): OAuthCallback {
  const state = params.get("state");
  const clientId = params.get("client_id");
  return { code, ...(state ? { state } : {}), ...(clientId ? { clientId } : {}) };
}

// ----------------------------------------------------------------------------
// Token exchange + refresh
// ----------------------------------------------------------------------------

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

function tokensFromRaw(
  raw: RawTokenResponse,
  previousRefresh: string | undefined,
  now: number,
): OAuthTokens {
  if (!raw.access_token) {
    throw new OAuthError("Token response is missing `access_token`");
  }
  // A refresh response may omit refresh_token — keep the previous one.
  const refreshToken = raw.refresh_token ?? previousRefresh;
  if (!refreshToken) {
    throw new OAuthError("Token response is missing `refresh_token`");
  }
  const expiresInMs = (raw.expires_in ?? 3600) * 1000;
  const tokens: OAuthTokens = {
    accessToken: raw.access_token,
    refreshToken,
    expiresAt: now + expiresInMs - EXPIRY_SAFETY_MS,
  };
  if (raw.scope) tokens.scope = raw.scope;
  if (raw.id_token) tokens.idToken = raw.id_token;
  return tokens;
}

/** A sign-in that can't be refreshed: only signing in again helps. */
export class OAuthSignedOutError extends OAuthError {
  constructor(public readonly code: string) {
    super(`Sign-in ended (${code})`);
    this.name = "OAuthSignedOutError";
  }
}

const SIGNED_OUT_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

function tokenErrorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: string | { code?: string } };
    const code = typeof body.error === "string" ? body.error : body.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

async function postToken(
  provider: OAuthProviderConfig,
  params: Record<string, string>,
  fetchImpl: OAuthFetch,
): Promise<RawTokenResponse> {
  const init: RequestInit =
    provider.tokenEncoding === "json"
      ? {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(params),
        }
      : {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString(),
        };

  let res;
  try {
    res = await fetchImpl(provider.tokenUrl, init);
  } catch (err) {
    throw new OAuthError(
      `Token request to ${provider.label} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const text = await res.text().catch(() => "<no body>");
  if (!res.ok) {
    const code = tokenErrorCode(text);
    if (code && SIGNED_OUT_ERRORS.has(code)) throw new OAuthSignedOutError(code);
    throw new OAuthError(
      `${provider.label} token endpoint returned HTTP ${res.status}${code ? `: ${code}` : ""}`,
    );
  }
  try {
    return JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new OAuthError(`${provider.label} token endpoint returned non-JSON`);
  }
}

/** Exchange an authorization code for an access + refresh token bundle. */
export async function exchangeCodeForTokens(
  provider: OAuthProviderConfig,
  args: { code: string; verifier: string; state?: string; clientId?: string },
  fetchImpl: OAuthFetch = defaultFetch,
): Promise<OAuthTokens> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: args.clientId ?? provider.clientId,
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: provider.redirectUri,
    ...(provider.resource ? { resource: provider.resource } : {}),
  };
  if (provider.tokenExchangeIncludesState && args.state) {
    params.state = args.state;
  }
  const raw = await postToken(provider, params, fetchImpl);
  return tokensFromRaw(raw, undefined, Date.now());
}

/** Trade a refresh token for a fresh access + refresh bundle. No scope: that
 *  keeps the grant as it is. Identity carries over from the sign-in. */
export async function refreshTokens(
  provider: OAuthProviderConfig,
  previous: OAuthTokens,
  fetchImpl: OAuthFetch = defaultFetch,
): Promise<OAuthTokens> {
  const raw = await postToken(
    provider,
    {
      grant_type: "refresh_token",
      client_id: previous.clientId ?? provider.clientId,
      refresh_token: previous.refreshToken,
      ...(provider.resource ? { resource: provider.resource } : {}),
    },
    fetchImpl,
  );
  return { ...previous, ...tokensFromRaw(raw, previous.refreshToken, Date.now()) };
}

// ----------------------------------------------------------------------------
// Loopback callback server + flow orchestration
// ----------------------------------------------------------------------------

const CALLBACK_HTML = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><title>Foreman</title>` +
  `<body style="font:16px system-ui;text-align:center;padding:3rem">` +
  (ok
    ? `<h2>✅ Signed in</h2><p>You can close this tab and return to Foreman.</p>`
    : `<h2>❌ Sign-in failed</h2><p>Return to Foreman and try again.</p>`) +
  `</body>`;

/** Run a one-shot loopback HTTP server and resolve with the OAuth callback's
 *  `code` once the browser redirects to it. Closes itself on the first hit or
 *  when `signal` aborts. */
export function waitForLoopbackCallback(
  provider: OAuthProviderConfig,
  opts: { signal?: AbortSignal } = {},
): Promise<OAuthCallback> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://127.0.0.1:${provider.redirectPort}`,
      );
      if (url.pathname !== provider.redirectPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(CALLBACK_HTML(Boolean(code)));
      server.close();
      if (code) {
        resolve(callbackOf(code, url.searchParams));
      } else {
        reject(
          new OAuthError(
            `Authorization failed: ${error ?? "no code returned"}`,
          ),
        );
      }
    });
    server.on("error", (err) =>
      reject(
        new OAuthError(
          `Could not start the callback server on port ` +
            `${provider.redirectPort}: ${err.message}`,
        ),
      ),
    );
    opts.signal?.addEventListener("abort", () => {
      server.close();
      reject(new OAuthError("Login aborted"));
    });
    server.listen(provider.redirectPort, "127.0.0.1");
  });
}
