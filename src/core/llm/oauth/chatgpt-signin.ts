import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { SecretStore } from "../../secret-store.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  OAuthError,
  parseCallbackInput,
  waitForLoopbackCallback,
  type OAuthCallback,
  type OAuthFetch,
  type OAuthTokens,
} from "./oauth-flow.js";
import {
  CHATGPT_PLAN_SCOPE,
  getOAuthProvider,
  OPENAI_ISSUER,
  type OAuthProviderConfig,
} from "./oauth-providers.js";
import { generatePkce, generateState } from "./pkce.js";

// =============================================================================
// Sign in with ChatGPT, for an open-source app on the user's own machine
// =============================================================================
//
// OpenAI's guide: developers.openai.com/siwc/token-sharing-open-source.
// The first sign-in registers this computer and OpenAI issues a client id for
// it, bound to that account. Both are kept across sign-outs, because signing
// out ends the session, not the registration. The ID token is checked before
// anything is stored, and a sign-in without the plan scope doesn't count.

const REGISTRATION_SECRET = "llm-oauth-openai-registration";
const APP_NAME = "Foreman";
const JWKS_URL = `${OPENAI_ISSUER}/.well-known/jwks.json`;
const CLOCK_SKEW_SECONDS = 60;

export interface ChatgptRegistration {
  /** Opaque and stable for this computer: identifies nobody. */
  hostId: string;
  /** Issued by OpenAI on the first sign-in. */
  clientId?: string;
  /** The account it belongs to. */
  sub?: string;
}

type RegistrationStore = Pick<SecretStore, "exists" | "get" | "add" | "rotate">;

function loadRegistration(store: RegistrationStore): ChatgptRegistration {
  if (store.exists(REGISTRATION_SECRET)) {
    const saved = JSON.parse(store.get(REGISTRATION_SECRET)) as ChatgptRegistration;
    if (typeof saved.hostId === "string") return saved;
  }
  return { hostId: `urn:uuid:${randomUUID()}` };
}

function saveRegistration(store: RegistrationStore, registration: ChatgptRegistration): void {
  const json = JSON.stringify(registration);
  if (store.exists(REGISTRATION_SECRET)) store.rotate(REGISTRATION_SECRET, json);
  else store.add(REGISTRATION_SECRET, json);
}

export interface SignInIo {
  presentAuthUrl: (url: string) => void | Promise<void>;
  readPastedCode?: () => Promise<string>;
  useLoopback?: boolean;
}

/** The whole sign-in. Returns tokens that have passed every check; the
 *  caller stores them. */
export async function signInWithChatgpt(
  store: RegistrationStore,
  io: SignInIo,
  fetchImpl?: OAuthFetch,
): Promise<OAuthTokens> {
  const provider = getOAuthProvider("openai");
  const registration = loadRegistration(store);
  saveRegistration(store, registration);
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const nonce = randomBytes(16).toString("base64url");
  const url = buildAuthorizeUrl(provider, challenge, state, {
    nonce,
    ...(registration.clientId
      ? { client_id: registration.clientId }
      : { ext_agent_host_id: registration.hostId, agent_name_hint: APP_NAME }),
  });

  // The listener has to be up before the browser can come back to it.
  const abort = new AbortController();
  const racers: Promise<OAuthCallback>[] = [];
  if (io.useLoopback !== false) racers.push(waitForLoopbackCallback(provider, { signal: abort.signal }));
  if (io.readPastedCode) racers.push(io.readPastedCode().then((raw) => parseCallbackInput(raw)));
  if (racers.length === 0) throw new OAuthError("No way to receive the authorization code");

  let callback: OAuthCallback;
  try {
    await io.presentAuthUrl(url);
    callback = await Promise.race(racers);
  } finally {
    abort.abort();
  }

  if (callback.state !== state) throw new OAuthError("OAuth state mismatch — aborting (possible CSRF)");
  const clientId = issuedClientId(registration, callback);
  const tokens = await exchangeCodeForTokens(
    provider,
    { code: callback.code, verifier, clientId },
    fetchImpl,
  );
  const identity = await verifyIdToken(tokens.idToken, { clientId, nonce }, fetchImpl);
  if (registration.sub && registration.sub !== identity.sub) {
    throw new OAuthError("That's a different ChatGPT account from the one this computer signed in with.");
  }
  requirePlanScope(tokens);
  saveRegistration(store, { ...registration, clientId, sub: identity.sub });
  return { ...tokens, clientId, sub: identity.sub, ...(identity.email ? { email: identity.email } : {}) };
}

/** A first sign-in must come back with an id; a later one may omit it but
 *  can't change it. */
function issuedClientId(registration: ChatgptRegistration, callback: OAuthCallback): string {
  if (registration.clientId) {
    if (callback.clientId && callback.clientId !== registration.clientId) {
      throw new OAuthError("OpenAI answered with a different client id. Sign in again.");
    }
    return registration.clientId;
  }
  if (!callback.clientId) throw new OAuthError("OpenAI didn't finish registering Foreman. Sign in again.");
  return callback.clientId;
}

function requirePlanScope(tokens: OAuthTokens): void {
  if (tokens.scope?.split(/\s+/).includes(CHATGPT_PLAN_SCOPE)) return;
  throw new OAuthError(
    "You signed in, but ChatGPT plan use wasn't allowed, so Foreman can't use it. " +
      "Sign in again and allow it, or add an API key instead.",
  );
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

function decodeJwtPart(part: string | undefined): Record<string, unknown> {
  if (!part) throw new OAuthError("OpenAI's ID token is malformed");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OAuthError("OpenAI's ID token is malformed");
  }
}

/** Check the ID token's signature against OpenAI's published keys, then who
 *  issued it, for whom, until when, and for this sign-in. */
export async function verifyIdToken(
  idToken: string | undefined,
  expected: { clientId: string; nonce: string },
  fetchImpl: OAuthFetch = (url, init) => fetch(url, init) as never,
  now: number = Date.now(),
): Promise<{ sub: string; email?: string }> {
  if (!idToken) throw new OAuthError("OpenAI sent no ID token");
  const [head, body, signature] = idToken.split(".");
  const header = decodeJwtPart(head);
  const claims = decodeJwtPart(body);
  if (header.alg !== "RS256" || !signature) throw new OAuthError("OpenAI's ID token has an unexpected signature");

  const res = await fetchImpl(JWKS_URL, { method: "GET" });
  if (!res.ok) throw new OAuthError(`Couldn't read OpenAI's signing keys (HTTP ${res.status})`);
  const { keys } = JSON.parse(await res.text()) as { keys?: Jwk[] };
  const jwk = keys?.find((k) => k.kid === header.kid);
  if (!jwk) throw new OAuthError("OpenAI's ID token is signed with an unknown key");
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  const signed = verify("RSA-SHA256", Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url"));
  if (!signed) throw new OAuthError("OpenAI's ID token signature doesn't verify");

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== OPENAI_ISSUER) throw new OAuthError("OpenAI's ID token has the wrong issuer");
  if (!audience.includes(expected.clientId)) throw new OAuthError("OpenAI's ID token is for another client");
  if (claims.nonce !== expected.nonce) throw new OAuthError("OpenAI's ID token is for another sign-in");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now / 1000) {
    throw new OAuthError("OpenAI's ID token has expired");
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new OAuthError("OpenAI's ID token names no account");
  return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

/** End the session at OpenAI. True when OpenAI confirmed it. The registration
 *  stays for the next sign-in. */
export async function revokeChatgptSession(
  tokens: Pick<OAuthTokens, "refreshToken" | "clientId">,
  fetchImpl: OAuthFetch = (url, init) => fetch(url, init) as never,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  if (!tokens.clientId) return false;
  const body = new URLSearchParams({
    token: tokens.refreshToken,
    token_type_hint: "refresh_token",
    client_id: tokens.clientId,
  }).toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await wait(attempt * 1000);
    try {
      const discovery = await fetchImpl(`${OPENAI_ISSUER}/.well-known/openid-configuration`, { method: "GET" });
      const { revocation_endpoint: endpoint } = JSON.parse(await discovery.text()) as { revocation_endpoint?: string };
      if (!endpoint) return false;
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (res.ok) return true;
      if (res.status < 500) return false;
    } catch {
      // Network trouble: try again.
    }
  }
  return false;
}

export type { OAuthProviderConfig };
