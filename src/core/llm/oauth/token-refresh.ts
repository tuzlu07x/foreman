import type { SecretStore } from "../../secret-store.js";
import {
  OAuthError,
  refreshTokens,
  type OAuthFetch,
  type OAuthTokens,
} from "./oauth-flow.js";
import { getOAuthProvider, type OAuthProviderId } from "./oauth-providers.js";
import { loadOAuthTokens, saveOAuthTokens } from "./token-store.js";

export async function getValidOAuthTokens(
  store: SecretStore,
  provider: OAuthProviderId,
  fetchImpl?: OAuthFetch,
  now: number = Date.now(),
): Promise<OAuthTokens> {
  const tokens = loadOAuthTokens(store, provider);
  if (!tokens) {
    throw new OAuthError(
      `Not signed in to ${provider} — run \`foreman llm login ${provider}\``,
    );
  }
  if (now < tokens.expiresAt) return tokens;

  const refreshed = await refreshTokens(
    getOAuthProvider(provider),
    tokens.refreshToken,
    fetchImpl,
  );
  saveOAuthTokens(store, provider, refreshed);
  return refreshed;
}

export interface OAuthCredential {
  accessToken: string;
  accountId?: string;
}

export type AccessTokenProvider = () => Promise<OAuthCredential>;

export function makeAccessTokenProvider(
  store: SecretStore,
  provider: OAuthProviderId,
  fetchImpl?: OAuthFetch,
): AccessTokenProvider {
  return async () => {
    const tokens = await getValidOAuthTokens(store, provider, fetchImpl);
    const cred: OAuthCredential = { accessToken: tokens.accessToken };
    if (tokens.accountId) cred.accountId = tokens.accountId;
    return cred;
  };
}
