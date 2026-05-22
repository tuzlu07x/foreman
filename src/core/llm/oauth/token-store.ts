import { SecretNotFoundError, type SecretStore } from "../../secret-store.js";
import { OAuthError, type OAuthTokens } from "./oauth-flow.js";
import type { OAuthProviderId } from "./oauth-providers.js";

export function oauthSecretName(provider: OAuthProviderId): string {
  return `llm-oauth-${provider}`;
}

export function saveOAuthTokens(
  store: SecretStore,
  provider: OAuthProviderId,
  tokens: OAuthTokens,
): void {
  const name = oauthSecretName(provider);
  const json = JSON.stringify(tokens);
  if (store.exists(name)) {
    store.rotate(name, json);
  } else {
    store.add(name, json);
  }
}

export function loadOAuthTokens(
  store: SecretStore,
  provider: OAuthProviderId,
): OAuthTokens | null {
  let json: string;
  try {
    json = store.get(oauthSecretName(provider));
  } catch (err) {
    if (err instanceof SecretNotFoundError) return null;
    throw err;
  }
  return parseTokens(json);
}

export function clearOAuthTokens(
  store: SecretStore,
  provider: OAuthProviderId,
): void {
  const name = oauthSecretName(provider);
  if (store.exists(name)) store.remove(name);
}

function parseTokens(json: string): OAuthTokens {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new OAuthError("Stored OAuth token bundle is corrupt (not JSON)");
  }
  const t = raw as Partial<OAuthTokens>;
  if (
    typeof t.accessToken !== "string" ||
    typeof t.refreshToken !== "string" ||
    typeof t.expiresAt !== "number"
  ) {
    throw new OAuthError("Stored OAuth token bundle is missing fields");
  }
  const tokens: OAuthTokens = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
  };
  if (typeof t.accountId === "string") tokens.accountId = t.accountId;
  return tokens;
}
