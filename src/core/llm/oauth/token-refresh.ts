import type { SecretStore } from "../../secret-store.js";
import {
  OAuthError,
  OAuthSignedOutError,
  refreshTokens,
  type OAuthFetch,
  type OAuthTokens,
} from "./oauth-flow.js";
import { getOAuthProvider, type OAuthProviderId } from "./oauth-providers.js";
import { clearOAuthTokens, loadOAuthTokens, saveOAuthTokens } from "./token-store.js";

/** A refresh running in this process. Refresh tokens rotate, so two at once
 *  would spend the same one and end the session. */
const refreshing = new Map<OAuthProviderId, Promise<OAuthTokens>>();

function signInAgain(provider: OAuthProviderId): OAuthError {
  return new OAuthError(`Your ChatGPT sign-in has ended — run \`foreman llm login ${provider}\``);
}

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
  const running = refreshing.get(provider);
  if (running) return running;
  const refresh = refreshTokens(getOAuthProvider(provider), tokens, fetchImpl)
    .then((refreshed) => {
      saveOAuthTokens(store, provider, refreshed);
      return refreshed;
    })
    .catch((err: unknown) => {
      if (!(err instanceof OAuthSignedOutError)) throw err;
      clearOAuthTokens(store, provider);
      throw signInAgain(provider);
    })
    .finally(() => refreshing.delete(provider));
  refreshing.set(provider, refresh);
  return refresh;
}

export interface OAuthCredential {
  accessToken: string;
}

export type AccessTokenProvider = () => Promise<OAuthCredential>;

export function makeAccessTokenProvider(
  store: SecretStore,
  provider: OAuthProviderId,
  fetchImpl?: OAuthFetch,
): AccessTokenProvider {
  return async () => {
    const tokens = await getValidOAuthTokens(store, provider, fetchImpl);
    return { accessToken: tokens.accessToken };
  };
}
