import { createServer } from "node:http";
import type { OAuthProviderConfig } from "./oauth-providers.js";
import { generatePkce, generateState } from "./pkce.js";

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
  accountId?: string;
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
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", provider.redirectUri);
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(provider.extraAuthorizeParams)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export function parseCallbackInput(input: string): {
  code: string;
  state?: string;
} {
  const trimmed = input.trim();
  if (trimmed === "") throw new OAuthError("Empty authorization input");

  if (/^https?:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const code = u.searchParams.get("code");
    if (!code) throw new OAuthError("No `code` parameter in the pasted URL");
    return { code, state: u.searchParams.get("state") ?? undefined };
  }
  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#");
    if (!code) throw new OAuthError('No code before the "#"');
    return { code, state: state || undefined };
  }
  if (trimmed.includes("=")) {
    const params = new URLSearchParams(trimmed);
    const code = params.get("code");
    if (code) return { code, state: params.get("state") ?? undefined };
  }
  return { code: trimmed };
}

export function decodeChatgptAccountId(
  accessToken: string,
): string | undefined {
  const segments = accessToken.split(".");
  if (segments.length < 2) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const id = auth?.["chatgpt_account_id"];
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------------------
// Token exchange + refresh
// ----------------------------------------------------------------------------

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function tokensFromRaw(
  provider: OAuthProviderConfig,
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
  if (provider.id === "openai") {
    const accountId = decodeChatgptAccountId(raw.access_token);
    if (accountId) tokens.accountId = accountId;
  }
  return tokens;
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
    throw new OAuthError(
      `${provider.label} token endpoint returned HTTP ${res.status}: ${text}`,
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
  args: { code: string; verifier: string; state?: string },
  fetchImpl: OAuthFetch = defaultFetch,
): Promise<OAuthTokens> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: provider.clientId,
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: provider.redirectUri,
  };
  if (provider.tokenExchangeIncludesState && args.state) {
    params.state = args.state;
  }
  const raw = await postToken(provider, params, fetchImpl);
  return tokensFromRaw(provider, raw, undefined, Date.now());
}

/** Trade a refresh token for a fresh access + refresh bundle. */
export async function refreshTokens(
  provider: OAuthProviderConfig,
  refreshToken: string,
  fetchImpl: OAuthFetch = defaultFetch,
): Promise<OAuthTokens> {
  const raw = await postToken(
    provider,
    {
      grant_type: "refresh_token",
      client_id: provider.clientId,
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
  return tokensFromRaw(provider, raw, refreshToken, Date.now());
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
): Promise<{ code: string; state?: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://localhost:${provider.redirectPort}`,
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
        resolve({ code, state: url.searchParams.get("state") ?? undefined });
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

export interface LoginFlowIO {
  presentAuthUrl: (url: string) => void | Promise<void>;
  readPastedCode?: () => Promise<string>;
  useLoopback?: boolean;
}

export async function runLoginFlow(
  provider: OAuthProviderConfig,
  io: LoginFlowIO,
  fetchImpl: OAuthFetch = defaultFetch,
): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePkce();
  const state =
    provider.stateMode === "pkce-verifier" ? verifier : generateState();
  const authUrl = buildAuthorizeUrl(provider, challenge, state);

  await io.presentAuthUrl(authUrl);

  const useLoopback = io.useLoopback !== false;
  const abort = new AbortController();
  const racers: Promise<{ code: string; state?: string }>[] = [];
  if (useLoopback) {
    racers.push(waitForLoopbackCallback(provider, { signal: abort.signal }));
  }
  if (io.readPastedCode) {
    racers.push(io.readPastedCode().then((raw) => parseCallbackInput(raw)));
  }
  if (racers.length === 0) {
    throw new OAuthError("No way to receive the authorization code");
  }

  let captured: { code: string; state?: string };
  try {
    captured = await Promise.race(racers);
  } finally {
    abort.abort();
  }

  if (captured.state !== undefined && captured.state !== state) {
    throw new OAuthError("OAuth state mismatch — aborting (possible CSRF)");
  }
  return exchangeCodeForTokens(
    provider,
    { code: captured.code, verifier, state },
    fetchImpl,
  );
}
