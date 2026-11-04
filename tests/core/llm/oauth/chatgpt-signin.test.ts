import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  revokeChatgptSession,
  signInWithChatgpt,
  verifyIdToken,
} from "../../../../src/core/llm/oauth/chatgpt-signin.js";
import type { OAuthFetch } from "../../../../src/core/llm/oauth/oauth-flow.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }): string {
  const signing = `${b64(header)}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256").update(signing).sign(privateKey, "base64url");
  return `${signing}.${signature}`;
}

const NOW = 1_800_000_000_000;
const good = (over: Record<string, unknown> = {}) => ({
  iss: "https://auth.openai.com",
  aud: "oaiapp_1",
  nonce: "N",
  exp: NOW / 1000 + 600,
  sub: "user-1",
  email: "a@b.c",
  ...over,
});
const keys: OAuthFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ keys: [jwk] }) });
const verifyWith = (token: string | undefined) =>
  verifyIdToken(token, { clientId: "oaiapp_1", nonce: "N" }, keys, NOW);

describe("verifyIdToken", () => {
  it("accepts a token OpenAI signed for this sign-in", async () => {
    await expect(verifyWith(idToken(good()))).resolves.toEqual({ sub: "user-1", email: "a@b.c" });
  });

  it.each([
    ["the wrong issuer", { iss: "https://evil.example" }],
    ["another client", { aud: "oaiapp_2" }],
    ["another sign-in", { nonce: "X" }],
    ["an expired token", { exp: NOW / 1000 - 3600 }],
  ])("refuses %s", async (_name, over) => {
    await expect(verifyWith(idToken(good(over)))).rejects.toThrow(/ID token/);
  });

  it("refuses a forged signature", async () => {
    const [head, , sig] = idToken(good()).split(".");
    const forged = `${head}.${b64(good({ sub: "attacker" }))}.${sig}`;
    await expect(verifyWith(forged)).rejects.toThrow(/signature/);
  });

  it("refuses an unsigned token", async () => {
    await expect(verifyWith(`${b64({ alg: "none" })}.${b64(good())}.`)).rejects.toThrow(/signature/);
  });

  it("refuses a key OpenAI doesn't publish", async () => {
    await expect(verifyWith(idToken(good(), { alg: "RS256", kid: "other" }))).rejects.toThrow(/unknown key/);
  });
});

/** An in-memory secret store. */
function secrets(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    exists: (n: string) => data.has(n),
    get: (n: string) => data.get(n)!,
    add: (n: string, v: string) => void data.set(n, v),
    rotate: (n: string, v: string) => void data.set(n, v),
  };
}

/** Plays OpenAI: reads the authorize URL, answers the callback and token call. */
function openai(opts: { scope?: string; issued?: string | null; state?: string; sub?: string } = {}) {
  const seen: { authorize?: URL; token?: URLSearchParams } = {};
  let nonce = "";
  let state = "";
  let clientId = "";
  const io = {
    useLoopback: false,
    presentAuthUrl: (url: string) => {
      seen.authorize = new URL(url);
      nonce = seen.authorize.searchParams.get("nonce")!;
      state = seen.authorize.searchParams.get("state")!;
    },
    readPastedCode: async () => {
      await new Promise((r) => setImmediate(r));
      const issued = opts.issued === undefined ? "oaiapp_1" : opts.issued;
      clientId = issued ?? seen.authorize!.searchParams.get("client_id")!;
      const q = new URLSearchParams({ code: "CODE", state: opts.state ?? state, ...(issued ? { client_id: issued } : {}) });
      return `http://127.0.0.1:1455/auth/callback?${q.toString()}`;
    },
  };
  const fetchImpl: OAuthFetch = async (url, init) => {
    if (url.endsWith("/jwks.json")) return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [jwk] }) };
    seen.token = new URLSearchParams(String(init.body));
    const claims = { ...good({ nonce, aud: clientId, exp: Date.now() / 1000 + 600 }), sub: opts.sub ?? "user-1" };
    const body = {
      access_token: "AT",
      refresh_token: "RT",
      expires_in: 3600,
      scope: opts.scope ?? "openid chatgpt.tokens.use.direct",
      id_token: idToken(claims),
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { io, fetchImpl, seen };
}

describe("signInWithChatgpt", () => {
  it("registers on the first sign-in with an opaque host id and keeps what OpenAI issues", async () => {
    const store = secrets();
    const o = openai();
    const tokens = await signInWithChatgpt(store, o.io, o.fetchImpl);
    const query = o.seen.authorize!.searchParams;
    expect(query.get("client_id")).toBe("dynamic_agent_client");
    expect(query.get("agent_name_hint")).toBe("Foreman");
    expect(query.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(o.seen.token!.get("client_id")).toBe("oaiapp_1");
    expect(o.seen.token!.get("resource")).toBe("https://api.openai.com/v1");
    expect(tokens).toMatchObject({ clientId: "oaiapp_1", sub: "user-1", email: "a@b.c" });
    expect(JSON.parse(store.data.get("llm-oauth-openai-registration")!)).toMatchObject({ clientId: "oaiapp_1", sub: "user-1" });
  });

  it("uses the saved client id later, and no registration fields", async () => {
    const store = secrets();
    const first = openai();
    await signInWithChatgpt(store, first.io, first.fetchImpl);
    const later = openai({ issued: null });
    await signInWithChatgpt(store, later.io, later.fetchImpl);
    const query = later.seen.authorize!.searchParams;
    expect(query.get("client_id")).toBe("oaiapp_1");
    expect(query.has("ext_agent_host_id")).toBe(false);
    expect(query.has("agent_name_hint")).toBe(false);
  });

  it("refuses a callback that doesn't match this sign-in", async () => {
    const o = openai({ state: "forged" });
    await expect(signInWithChatgpt(secrets(), o.io, o.fetchImpl)).rejects.toThrow(/state mismatch/);
    expect(o.seen.token).toBeUndefined();
  });

  it("stops when plan use wasn't granted, keeping nothing", async () => {
    const o = openai({ scope: "openid profile" });
    await expect(signInWithChatgpt(secrets(), o.io, o.fetchImpl)).rejects.toThrow(/plan use wasn't allowed/);
  });

  it("treats a registration with no issued id as unfinished", async () => {
    const o = openai({ issued: null });
    await expect(signInWithChatgpt(secrets(), o.io, o.fetchImpl)).rejects.toThrow(/finish registering/);
  });

  it("won't mix another account into this computer's registration", async () => {
    const store = secrets();
    const first = openai();
    await signInWithChatgpt(store, first.io, first.fetchImpl);
    const other = openai({ issued: null, sub: "user-2" });
    await expect(signInWithChatgpt(store, other.io, other.fetchImpl)).rejects.toThrow(/different ChatGPT account/);
  });
});

describe("revokeChatgptSession", () => {
  const tokens = { refreshToken: "RT", clientId: "oaiapp_1" };
  const discovery = { ok: true, status: 200, text: async () => JSON.stringify({ revocation_endpoint: "https://auth.openai.com/revoke" }) };

  it("revokes the refresh token at the endpoint OpenAI publishes", async () => {
    let body = "";
    const fetchImpl: OAuthFetch = async (url, init) => {
      if (url.includes("openid-configuration")) return discovery;
      body = String(init.body);
      return { ok: true, status: 200, text: async () => "" };
    };
    expect(await revokeChatgptSession(tokens, fetchImpl)).toBe(true);
    const params = new URLSearchParams(body);
    expect(Object.fromEntries(params)).toEqual({ token: "RT", token_type_hint: "refresh_token", client_id: "oaiapp_1" });
  });

  it("retries network trouble, then says it couldn't confirm", async () => {
    let calls = 0;
    const fetchImpl: OAuthFetch = async () => {
      calls++;
      throw new Error("offline");
    };
    expect(await revokeChatgptSession(tokens, fetchImpl, async () => undefined)).toBe(false);
    expect(calls).toBe(3);
  });
});
