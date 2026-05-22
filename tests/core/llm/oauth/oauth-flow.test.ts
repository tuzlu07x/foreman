import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  decodeChatgptAccountId,
  exchangeCodeForTokens,
  OAuthError,
  parseCallbackInput,
  refreshTokens,
  type OAuthFetch,
} from "../../../../src/core/llm/oauth/oauth-flow.js";
import { getOAuthProvider } from "../../../../src/core/llm/oauth/oauth-providers.js";

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

describe("buildAuthorizeUrl", () => {
  it("includes all required PKCE params for Anthropic", () => {
    const provider = getOAuthProvider("anthropic");
    const url = new URL(buildAuthorizeUrl(provider, "CHAL", "STATE"));
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(provider.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(provider.redirectUri);
    expect(url.searchParams.get("code_challenge")).toBe("CHAL");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).toContain("user:inference");
    expect(url.searchParams.get("code")).toBe("true");
  });

  it("includes the codex-cli extras for OpenAI", () => {
    const provider = getOAuthProvider("openai");
    const url = new URL(buildAuthorizeUrl(provider, "C", "S"));
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
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

  it("throws on empty / whitespace-only input", () => {
    expect(() => parseCallbackInput("   ")).toThrow(OAuthError);
  });

  it("throws when a pasted URL has no `code` param", () => {
    expect(() =>
      parseCallbackInput("http://x.test/callback?state=only"),
    ).toThrow(/No `code`/);
  });
});

describe("decodeChatgptAccountId", () => {
  it("extracts the chatgpt_account_id claim from a JWT", () => {
    const jwt = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc_42" },
    });
    expect(decodeChatgptAccountId(jwt)).toBe("acc_42");
  });

  it("returns undefined for non-JWT input", () => {
    expect(decodeChatgptAccountId("plain-string")).toBeUndefined();
    expect(decodeChatgptAccountId("a.b")).toBeUndefined();
  });

  it("returns undefined when the claim is absent", () => {
    expect(decodeChatgptAccountId(makeJwt({ sub: "foo" }))).toBeUndefined();
  });
});

describe("exchangeCodeForTokens — OpenAI (form encoding, no state echo)", () => {
  it("sends the correct form body and returns parsed tokens with accountId", async () => {
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
    expect(params.get("state")).toBeNull();

    expect(tokens.accessToken).toBe(access);
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.accountId).toBe("acc_42");
    // 5-min safety margin baked into expiresAt.
    const now = Date.now();
    expect(tokens.expiresAt).toBeGreaterThan(now + 50 * 60 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(now + 60 * 60 * 1000);
  });
});

describe("exchangeCodeForTokens — Anthropic (JSON encoding, state echo)", () => {
  it("sends a JSON body that includes state and omits accountId", async () => {
    const provider = getOAuthProvider("anthropic");
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
    expect(tokens.accountId).toBeUndefined();
  });
});

describe("refreshTokens", () => {
  const provider = getOAuthProvider("anthropic");

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
    const tokens = await refreshTokens(provider, "rt-old", f.fetchImpl);
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

  it("keeps the previous refresh token when the response omits one", async () => {
    const f = makeFetch([
      { body: { access_token: "sk-ant-oat03", expires_in: 600 } },
    ]);
    const tokens = await refreshTokens(provider, "rt-keep", f.fetchImpl);
    expect(tokens.refreshToken).toBe("rt-keep");
  });

  it("throws OAuthError on a non-2xx response", async () => {
    const f = makeFetch([{ status: 401, textBody: '{"error":"bad refresh"}' }]);
    await expect(refreshTokens(provider, "rt", f.fetchImpl)).rejects.toThrow(
      OAuthError,
    );
  });

  it("throws OAuthError when the response has no access_token", async () => {
    const f = makeFetch([{ body: { expires_in: 600 } }]);
    await expect(refreshTokens(provider, "rt", f.fetchImpl)).rejects.toThrow(
      /access_token/,
    );
  });

  it("throws OAuthError when the response is not JSON", async () => {
    const f = makeFetch([{ textBody: "<html>500</html>" }]);
    await expect(refreshTokens(provider, "rt", f.fetchImpl)).rejects.toThrow(
      /non-JSON/,
    );
  });
});
