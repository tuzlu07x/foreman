import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { generateState } from "../llm/oauth/pkce.js";
import {
  assertSecureEndpoint,
  describeOAuthFailure,
  hardenedOAuthFetch,
  McpOAuthError,
} from "./oauth-http.js";
import type { McpOAuthRecord } from "./oauth-store.js";

// =============================================================================
// `foreman mcp login <name>` — the MCP authorization flow
// =============================================================================
//
// RFC 9728 protected-resource discovery → RFC 8414 authorization-server
// metadata → RFC 7591 dynamic client registration → authorization code with
// PKCE (S256) → a one-shot redirect listener on 127.0.0.1 (random port,
// `state` checked, timed out) → code exchange. The SDK's `client/auth`
// helpers do the protocol work; this module adds the checks Foreman insists
// on and never lets a token or code reach an error message.

export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
export const MAX_LOGIN_TIMEOUT_MS = 30 * 60_000;
const CALLBACK_PATH = "/callback";
const CLIENT_NAME = "Foreman MCP Hub";

export interface McpOAuthLoginOptions {
  /** mcp.yaml server name. */
  server: string;
  /** The server's streamable-HTTP URL from mcp.yaml. */
  serverUrl: string;
  /** Space-separated scopes; defaults to what the server advertises. */
  scope?: string;
  /** Show (and optionally open) the authorization URL. */
  presentAuthUrl: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  now?: () => number;
}

export async function runMcpOAuthLogin(opts: McpOAuthLoginOptions): Promise<McpOAuthRecord> {
  const secrets: string[] = [];
  try {
    return await login(opts, secrets);
  } catch (err) {
    throw new McpOAuthError(`OAuth login for '${opts.server}' failed: ${describeOAuthFailure(err, secrets)}`);
  }
}

async function login(opts: McpOAuthLoginOptions, secrets: string[]): Promise<McpOAuthRecord> {
  const now = opts.now ?? (() => Date.now());
  const serverUrl = assertSecureEndpoint(opts.serverUrl, "MCP server URL");
  const fetchFn = hardenedOAuthFetch(opts.fetchFn);

  const info = await discoverOAuthServerInfo(serverUrl, { fetchFn });
  const authServerUrl = assertSecureEndpoint(info.authorizationServerUrl, "authorization server URL");
  const metadata = info.authorizationServerMetadata;
  if (!metadata) {
    throw new McpOAuthError(
      `no OAuth authorization-server metadata found for ${authServerUrl.origin} — the server may not support MCP OAuth`,
    );
  }
  // RFC 8414 §3.3: the metadata must describe the server we asked about.
  if (trimSlash(metadata.issuer) !== trimSlash(authServerUrl.href)) {
    throw new McpOAuthError(
      `the authorization-server metadata names issuer ${metadata.issuer}, not ${authServerUrl.href}`,
    );
  }
  assertSecureEndpoint(metadata.authorization_endpoint, "authorization endpoint");
  assertSecureEndpoint(metadata.token_endpoint, "token endpoint");
  if (!metadata.registration_endpoint) {
    throw new McpOAuthError("the authorization server does not support dynamic client registration");
  }
  assertSecureEndpoint(metadata.registration_endpoint, "registration endpoint");
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new McpOAuthError("the authorization server does not advertise PKCE with S256 — refusing to continue");
  }

  // RFC 8707: always bind the tokens to this server — the published
  // resource when there is protected-resource metadata, else the URL itself.
  const requested = resourceUrlFromServerUrl(serverUrl);
  let resource = requested;
  if (info.resourceMetadata) {
    if (!checkResourceAllowed({ requestedResource: requested, configuredResource: info.resourceMetadata.resource })) {
      throw new McpOAuthError(
        `the protected-resource metadata is for ${info.resourceMetadata.resource}, not ${requested.href}`,
      );
    }
    resource = new URL(info.resourceMetadata.resource);
  }
  // Least privilege: no scope unless the user asks for one; the server
  // grants its default.
  const scope = opts.scope;

  const state = generateState();
  const receiver = await startLoopbackReceiver({
    state,
    timeoutMs: Math.min(opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, MAX_LOGIN_TIMEOUT_MS),
    issuer: metadata.issuer,
    requireIss: (metadata as Record<string, unknown>)["authorization_response_iss_parameter_supported"] === true,
  });
  try {
    const client = await registerClient(authServerUrl, {
      metadata,
      clientMetadata: {
        client_name: CLIENT_NAME,
        redirect_uris: [receiver.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      ...(scope ? { scope } : {}),
      fetchFn,
    });
    if (client.client_secret) secrets.push(client.client_secret);

    const { authorizationUrl, codeVerifier } = await startAuthorization(authServerUrl, {
      metadata,
      clientInformation: client,
      redirectUrl: receiver.redirectUri,
      state,
      ...(scope ? { scope } : {}),
      resource,
    });
    secrets.push(codeVerifier);
    await opts.presentAuthUrl(authorizationUrl.href);

    const code = await receiver.result;
    secrets.push(code);
    const tokens = await exchangeAuthorization(authServerUrl, {
      metadata,
      clientInformation: client,
      authorizationCode: code,
      codeVerifier,
      redirectUri: receiver.redirectUri,
      resource,
      fetchFn,
    });
    secrets.push(tokens.access_token);
    if (tokens.refresh_token) secrets.push(tokens.refresh_token);
    if (tokens.token_type.toLowerCase() !== "bearer") {
      throw new McpOAuthError(`unsupported token type '${tokens.token_type}' (only Bearer is supported)`);
    }

    const obtainedAt = now();
    return {
      version: 1,
      server: opts.server,
      server_url: opts.serverUrl,
      authorization_server_url: authServerUrl.href,
      resource: resource.href,
      ...(scope ? { scope } : {}),
      metadata: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>,
      client: {
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
        ...(client.token_endpoint_auth_method
          ? { token_endpoint_auth_method: client.token_endpoint_auth_method }
          : {}),
      },
      redirect_uri: receiver.redirectUri,
      tokens: {
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
      expires_at: tokens.expires_in !== undefined ? obtainedAt + tokens.expires_in * 1000 : null,
      obtained_at: obtainedAt,
    };
  } finally {
    receiver.close();
  }
}

// -----------------------------------------------------------------------------
// One-shot loopback redirect listener
// -----------------------------------------------------------------------------

export interface LoopbackReceiver {
  redirectUri: string;
  /** The address the listener is bound to (always 127.0.0.1). */
  host: string;
  port: number;
  /** The authorization code from the first callback. Rejects when that
   *  callback carries an error or the wrong `state`, or on timeout. */
  result: Promise<string>;
  close(): void;
}

export interface LoopbackReceiverOptions {
  state: string;
  timeoutMs: number;
  /** When set and the callback carries RFC 9207 `iss`, they must match. */
  issuer?: string;
  /** The server promised `iss` (RFC 9207): a callback without it is refused. */
  requireIss?: boolean;
}

const RESULT_PAGE = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><title>Foreman</title>` +
  `<body style="font:16px system-ui;text-align:center;padding:3rem">` +
  (ok
    ? `<h2>Signed in</h2><p>You can close this tab and return to Foreman.</p>`
    : `<h2>Sign-in failed</h2><p>Return to Foreman for details.</p>`) +
  `</body>`;

export function startLoopbackReceiver(opts: LoopbackReceiverOptions): Promise<LoopbackReceiver> {
  let settled = false;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (err: Error) => void = () => undefined;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The flow awaits `result` only after registration and the browser step;
  // a timeout in between must not surface as an unhandled rejection.
  result.catch(() => undefined);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    if (settled) {
      res.writeHead(410, { "content-type": "text/plain" }).end("This sign-in callback was already used.");
      return;
    }
    const outcome = checkCallback(url.searchParams, opts);
    res.writeHead(outcome.ok ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end(RESULT_PAGE(outcome.ok));
    if (outcome.ok) finish(null, outcome.code);
    else finish(new McpOAuthError(outcome.reason));
  });

  const timer = setTimeout(() => {
    finish(new McpOAuthError(`timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for the browser sign-in`));
  }, opts.timeoutMs);

  function finish(err: Error | null, code?: string): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    if (err) rejectCode(err);
    else resolveCode(code!);
  }

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(new McpOAuthError(`could not start the local redirect listener: ${err.message}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
        host: address.address,
        port: address.port,
        result,
        close: () => finish(new McpOAuthError("login aborted")),
      });
    });
  });
}

type CallbackOutcome = { ok: true; code: string } | { ok: false; reason: string };

function checkCallback(params: URLSearchParams, opts: LoopbackReceiverOptions): CallbackOutcome {
  const state = params.get("state");
  if (state === null || !constantTimeEqual(state, opts.state)) {
    return { ok: false, reason: "OAuth state mismatch — refusing the callback (possible CSRF)" };
  }
  const error = params.get("error");
  if (error !== null) {
    const code = /^[A-Za-z0-9_.-]{1,64}$/.test(error) ? error : "error";
    return { ok: false, reason: `the authorization server refused the request (${code})` };
  }
  const iss = params.get("iss");
  if (iss === null && opts.requireIss) {
    return { ok: false, reason: "the callback is missing the `iss` parameter the server promised (RFC 9207)" };
  }
  if (iss !== null && opts.issuer !== undefined && iss !== opts.issuer) {
    return { ok: false, reason: "the callback came from a different issuer than the one discovered" };
  }
  const code = params.get("code");
  if (!code) return { ok: false, reason: "the callback carried no authorization code" };
  return { ok: true, code };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
