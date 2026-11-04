export type OAuthProviderId = "openai";

export type TokenEncoding = "form" | "json";

export type StateMode = "random" | "pkce-verifier";

export interface OAuthProviderConfig {
  readonly id: OAuthProviderId;
  readonly label: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scope: string;
  readonly redirectUri: string;
  readonly redirectPort: number;
  readonly redirectPath: string;
  readonly stateMode: StateMode;
  readonly tokenEncoding: TokenEncoding;
  readonly tokenExchangeIncludesState: boolean;
  readonly extraAuthorizeParams: Readonly<Record<string, string>>;
}

export const CODEX_ORIGINATOR = "codex_cli_rs";

const OPENAI: OAuthProviderConfig = {
  id: "openai",
  label: "Codex (ChatGPT)",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: "openid profile email offline_access",
  redirectUri: "http://localhost:1455/auth/callback",
  redirectPort: 1455,
  redirectPath: "/auth/callback",
  stateMode: "random",
  tokenEncoding: "form",
  tokenExchangeIncludesState: false,
  extraAuthorizeParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: CODEX_ORIGINATOR,
  },
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
