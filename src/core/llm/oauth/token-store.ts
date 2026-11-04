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

/** Claude tokens from when Foreman offered that sign-in itself. Nothing reads
 *  them any more and Foreman must not keep them. */
export function removeLegacyClaudeTokens(store: Pick<SecretStore, "exists" | "remove">): boolean {
  const name = "llm-oauth-anthropic";
  if (!store.exists(name)) return false;
  store.remove(name);
  return true;
}

/** ChatGPT tokens from before Foreman had its own registration: they came
 *  from Codex's client, which Foreman must not use, and can't refresh. */
export function removeLegacyChatgptTokens(store: Pick<SecretStore, "exists" | "get" | "remove">): boolean {
  const name = oauthSecretName("openai");
  if (!store.exists(name)) return false;
  try {
    if (parseTokens(store.get(name)).clientId) return false;
  } catch {
    // Unreadable is as good as gone.
  }
  store.remove(name);
  return true;
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
  if (typeof t.clientId === "string") tokens.clientId = t.clientId;
  if (typeof t.scope === "string") tokens.scope = t.scope;
  if (typeof t.idToken === "string") tokens.idToken = t.idToken;
  if (typeof t.sub === "string") tokens.sub = t.sub;
  if (typeof t.email === "string") tokens.email = t.email;
  return tokens;
}
