import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  OAuthError,
  OAuthSignedOutError,
  parseCallbackInput,
  refreshTokens,
  type OAuthFetch,
} from "../../../../src/core/llm/oauth/oauth-flow.js";
import {
  getOAuthProvider,
  type OAuthProviderConfig,
} from "../../../../src/core/llm/oauth/oauth-providers.js";

interface MockResp {
  status?: number;
  body?: unknown;
  textBody?: string;
}

function makeFetch(plan: MockResp[]): {
  fetchImpl: OAuthFetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  let cursor = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: OAuthFetch = async (url, init) => {
    calls.push({ url, init });
    const next = plan[cursor++] ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => next.textBody ?? JSON.stringify(next.body),
    };
  };
  return { fetchImpl, calls };
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from('{"alg":"none"}').toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

/** The flow's JSON-encoded, PKCE-state branch, which no shipped provider uses
 *  today. */
const jsonProvider: OAuthProviderConfig = {
  ...getOAuthProvider("openai"),
  authorizeUrl: "https://auth.example/authorize",
  tokenUrl: "https://auth.example/token",
  scope: "read",
  stateMode: "pkce-verifier",
  tokenEncoding: "json",
  tokenExchangeIncludesState: true,
  extraAuthorizeParams: { code: "true" },
};

describe("buildAuthorizeUrl", () => {
  it("includes all required PKCE params", () => {
    const provider = jsonProvider;
    const url = new URL(buildAuthorizeUrl(provider, "CHAL", "STATE"));
    expect(url.origin + url.pathname).toBe("https://auth.example/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(provider.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(provider.redirectUri);
    expect(url.searchParams.get("code_challenge")).toBe("CHAL");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).toBe("read");
    expect(url.searchParams.get("code")).toBe("true");
  });

  it("asks OpenAI for plan use, on the public API, as nobody but itself", () => {
    const provider = getOAuthProvider("openai");
    const url = new URL(buildAuthorizeUrl(provider, "C", "S", { nonce: "N" }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(url.searchParams.get("nonce")).toBe("N");
    expect(url.searchParams.has("originator")).toBe(false);
  });
});

describe("parseCallbackInput", () => {
  it("parses a full redirect URL", () => {
    expect(
      parseCallbackInput(
        "http://localhost:1455/auth/callback?code=abc&state=xyz",
      ),
    ).toEqual({ code: "abc", state: "xyz" });
  });

  it("parses a code#state fragment", () => {
    expect(parseCallbackInput("abc#xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("parses a raw query string", () => {
    expect(parseCallbackInput("code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("accepts a bare code with no state", () => {
    expect(parseCallbackInput("plain-code")).toEqual({ code: "plain-code" });
  });

  it("reads the client id a first registration comes back with", () => {
    const parsed = parseCallbackInput("http://127.0.0.1:1455/auth/callback?code=A&state=S&client_id=oaiapp_1");
    expect(parsed).toEqual({ code: "A", state: "S", clientId: "oaiapp_1" });
  });

  it("throws on empty / whitespace-only input", () => {
    expect(() => parseCallbackInput("   ")).toThrow(OAuthError);
  });

  it("throws when a pasted URL has no `code` param", () => {
    expect(() =>
      parseCallbackInput("http://x.test/callback?state=only"),
    ).toThrow(/No `code`/);
  });
});

describe("exchangeCodeForTokens — OpenAI (form encoding, no state echo)", () => {
  it("sends the correct form body and returns parsed tokens", async () => {
    const provider = getOAuthProvider("openai");
    const access = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc_42" },
    });
    const f = makeFetch([
      {
        body: {
          access_token: access,
          refresh_token: "rt-1",
          expires_in: 3600,
        },
      },
    ]);
    const tokens = await exchangeCodeForTokens(
      provider,
      { code: "CODE", verifier: "VER", state: "STATE" },
      f.fetchImpl,
    );
    expect(f.calls[0]!.url).toBe(provider.tokenUrl);
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe(provider.clientId);
    expect(params.get("code")).toBe("CODE");
    expect(params.get("code_verifier")).toBe("VER");
    expect(params.get("redirect_uri")).toBe(provider.redirectUri);
    expect(params.get("resource")).toBe("https://api.openai.com/v1");
    expect(params.get("state")).toBeNull();

    expect(tokens.accessToken).toBe(access);
    expect(tokens.refreshToken).toBe("rt-1");
    // 5-min safety margin baked into expiresAt.
    const now = Date.now();
    expect(tokens.expiresAt).toBeGreaterThan(now + 50 * 60 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(now + 60 * 60 * 1000);
  });
});

describe("exchangeCodeForTokens — JSON encoding, state echo", () => {
  it("sends a JSON body that includes state", async () => {
    const provider = jsonProvider;
    const f = makeFetch([
      {
        body: {
          access_token: "sk-ant-oat01",
          refresh_token: "rt-a",
          expires_in: 600,
        },
      },
    ]);
    const tokens = await exchangeCodeForTokens(
      provider,
      { code: "CODE", verifier: "VER", state: "STATE" },
      f.fetchImpl,
    );
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(String(f.calls[0]!.init.body)) as Record<
      string,
      unknown
    >;
    expect(parsed.grant_type).toBe("authorization_code");
    expect(parsed.code).toBe("CODE");
    expect(parsed.code_verifier).toBe("VER");
    expect(parsed.state).toBe("STATE");
  });
});

describe("refreshTokens", () => {
  const provider = jsonProvider;
  const bundle = (refreshToken: string) => ({ accessToken: "old", refreshToken, expiresAt: 0 });

  it("sends grant_type=refresh_token and parses the new bundle", async () => {
    const f = makeFetch([
      {
        body: {
          access_token: "sk-ant-oat02",
          refresh_token: "rt-new",
          expires_in: 600,
        },
      },
    ]);
    const tokens = await refreshTokens(provider, bundle("rt-old"), f.fetchImpl);
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("rt-old");
    expect(body.client_id).toBe(provider.clientId);
    expect(tokens.accessToken).toBe("sk-ant-oat02");
    expect(tokens.refreshToken).toBe("rt-new");
  });

  it("uses the issued client id, sends the resource, asks for no scope, keeps who signed in", async () => {
    const openai = getOAuthProvider("openai");
    const f = makeFetch([{ body: { access_token: "new", refresh_token: "rt-2", expires_in: 3600 } }]);
    const tokens = await refreshTokens(
      openai,
      { ...bundle("rt-1"), clientId: "oaiapp_1", sub: "user-1", email: "a@b.c" },
      f.fetchImpl,
    );
    const params = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(params.get("client_id")).toBe("oaiapp_1");
    expect(params.get("resource")).toBe("https://api.openai.com/v1");
    expect(params.has("scope")).toBe(false);
    expect(tokens).toMatchObject({ accessToken: "new", refreshToken: "rt-2", clientId: "oaiapp_1", sub: "user-1" });
  });

  it("says when only signing in again can help", async () => {
    const f = makeFetch([{ status: 400, textBody: '{"error":"refresh_token_reused"}' }]);
    await expect(refreshTokens(provider, bundle("rt"), f.fetchImpl)).rejects.toThrow(OAuthSignedOutError);
  });

  it("keeps what the token endpoint said, in both shapes, without anything secret", async () => {
    const shapedLikeAKey = `sk-ant-api03-${"a".repeat(60)}`;
    const flat = makeFetch([
      { status: 400, textBody: JSON.stringify({ error: "invalid_grant", error_description: `Bad code\n ${shapedLikeAKey}` }) },
    ]);
    const refused = await refreshTokens(provider, bundle("rt"), flat.fetchImpl).catch((e: OAuthSignedOutError) => e);
    expect(refused).toBeInstanceOf(OAuthSignedOutError);
    expect((refused as OAuthSignedOutError).detail).toMatch(/^Bad code \[REDACTED/);
    expect((refused as OAuthSignedOutError).message).not.toContain(shapedLikeAKey);

    const nested = makeFetch([
      { status: 400, textBody: JSON.stringify({ error: { code: "invalid_client", message: "Unknown client" } }) },
    ]);
    await expect(refreshTokens(provider, bundle("rt"), nested.fetchImpl)).rejects.toThrow(
      /HTTP 400: invalid_client \(Unknown client\)/,
    );
  });

  it("keeps the previous refresh token when the response omits one", async () => {
    const f = makeFetch([
      { body: { access_token: "sk-ant-oat03", expires_in: 600 } },
    ]);
    const tokens = await refreshTokens(provider, bundle("rt-keep"), f.fetchImpl);
    expect(tokens.refreshToken).toBe("rt-keep");
  });

  it("throws OAuthError on a non-2xx response", async () => {
    const f = makeFetch([{ status: 401, textBody: '{"error":"bad refresh"}' }]);
    await expect(refreshTokens(provider, bundle("rt"), f.fetchImpl)).rejects.toThrow(
      OAuthError,
    );
  });

  it("throws OAuthError when the response has no access_token", async () => {
    const f = makeFetch([{ body: { expires_in: 600 } }]);
    await expect(refreshTokens(provider, bundle("rt"), f.fetchImpl)).rejects.toThrow(
      /access_token/,
    );
  });

  it("throws OAuthError when the response is not JSON", async () => {
    const f = makeFetch([{ textBody: "<html>500</html>" }]);
    await expect(refreshTokens(provider, bundle("rt"), f.fetchImpl)).rejects.toThrow(
      /non-JSON/,
    );
  });
});
