export type OAuthProviderId = "openai";

export type TokenEncoding = "form" | "json";

export type StateMode = "random" | "pkce-verifier";

export interface OAuthProviderConfig {
  readonly id: OAuthProviderId;
  readonly label: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** The client id a first sign-in starts with; OpenAI issues Foreman's own
   *  during that sign-in (chatgpt-signin.ts). */
  readonly clientId: string;
  readonly scope: string;
  readonly redirectUri: string;
  readonly redirectPort: number;
  readonly redirectPath: string;
  readonly stateMode: StateMode;
  readonly tokenEncoding: TokenEncoding;
  readonly tokenExchangeIncludesState: boolean;
  readonly extraAuthorizeParams: Readonly<Record<string, string>>;
  /** Sent with every token request, when the provider wants one. */
  readonly resource?: string;
}

export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_API = "https://api.openai.com/v1";
/** The scope that lets a sign-in use the person's ChatGPT plan. */
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

// OpenAI's "Sign in with ChatGPT" for open-source and locally hosted apps
// (developers.openai.com/siwc/token-sharing-open-source). Foreman registers
// itself on first sign-in and calls the public API. It never borrows Codex's
// client id or calls ChatGPT's backend-api, which OpenAI's guide rules out.
const OPENAI: OAuthProviderConfig = {
  id: "openai",
  label: "ChatGPT",
  authorizeUrl: `${OPENAI_ISSUER}/api/accounts/authorize`,
  tokenUrl: `${OPENAI_ISSUER}/api/accounts/oauth/token`,
  clientId: "dynamic_agent_client",
  scope: `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`,
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  redirectPort: 1455,
  redirectPath: "/auth/callback",
  stateMode: "random",
  tokenEncoding: "form",
  tokenExchangeIncludesState: false,
  extraAuthorizeParams: { resource: OPENAI_API },
  resource: OPENAI_API,
};

const PROVIDERS: Record<OAuthProviderId, OAuthProviderConfig> = {
  openai: OPENAI,
};

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderConfig {
  return PROVIDERS[id];
}

export function isOAuthProviderId(id: string): id is OAuthProviderId {
  return id === "openai";
}
