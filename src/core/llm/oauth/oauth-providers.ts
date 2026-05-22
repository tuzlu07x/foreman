export type OAuthProviderId = "anthropic" | "openai";

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

const ANTHROPIC: OAuthProviderConfig = {
  id: "anthropic",
  label: "Claude (Anthropic)",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scope:
    "org:create_api_key user:profile user:inference " +
    "user:sessions:claude_code user:mcp_servers user:file_upload",
  redirectUri: "http://localhost:53692/callback",
  redirectPort: 53692,
  redirectPath: "/callback",
  stateMode: "pkce-verifier",
  tokenEncoding: "json",
  tokenExchangeIncludesState: true,
  extraAuthorizeParams: { code: "true" },
};

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
  anthropic: ANTHROPIC,
  openai: OPENAI,
};

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderConfig {
  return PROVIDERS[id];
}

export function isOAuthProviderId(id: string): id is OAuthProviderId {
  return id === "anthropic" || id === "openai";
}
