import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "../../../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../../../src/db/client.js";
import { generateMasterKey } from "../../../../src/identity/encryption.js";
import type { OAuthFetch } from "../../../../src/core/llm/oauth/oauth-flow.js";
import {
  loadOAuthTokens,
  saveOAuthTokens,
} from "../../../../src/core/llm/oauth/token-store.js";
import {
  getValidOAuthTokens,
  makeAccessTokenProvider,
} from "../../../../src/core/llm/oauth/token-refresh.js";

function mockFetch(...bodies: unknown[]): OAuthFetch {
  let i = 0;
  return async () => {
    const body = bodies[i++];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };
}

describe("getValidOAuthTokens", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let store: SecretStore;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    store = new SecretStore(db, generateMasterKey());
    void db;
  });
  afterEach(() => {
    sqlite.close();
  });

  it("throws when the user has never logged in", async () => {
    await expect(getValidOAuthTokens(store, "openai")).rejects.toThrow(
      /Not signed in/,
    );
  });

  it("returns the stored bundle when it is still valid", async () => {
    const now = Date.now();
    saveOAuthTokens(store, "openai", {
      accessToken: "A",
      refreshToken: "R",
      expiresAt: now + 60_000,
    });
    const tokens = await getValidOAuthTokens(
      store,
      "openai",
      undefined,
      now,
    );
    expect(tokens.accessToken).toBe("A");
  });

  it("refreshes and persists when the stored bundle is stale", async () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "OLD",
      refreshToken: "R-OLD",
      expiresAt: 1, // long ago
    });
    const fetchImpl = mockFetch({
      access_token: "NEW",
      refresh_token: "R-NEW",
      expires_in: 600,
    });
    const tokens = await getValidOAuthTokens(store, "openai", fetchImpl);
    expect(tokens.accessToken).toBe("NEW");
    expect(tokens.refreshToken).toBe("R-NEW");
    // Persisted to the store.
    expect(loadOAuthTokens(store, "openai")?.accessToken).toBe("NEW");
  });

  it("treats exactly-expired as stale (>= expiresAt)", async () => {
    const t = 1_000_000;
    saveOAuthTokens(store, "openai", {
      accessToken: "OLD",
      refreshToken: "R",
      expiresAt: t,
    });
    const fetchImpl = mockFetch({
      access_token: "NEW",
      refresh_token: "R2",
      expires_in: 600,
    });
    const tokens = await getValidOAuthTokens(store, "openai", fetchImpl, t);
    expect(tokens.accessToken).toBe("NEW");
  });
});

describe("makeAccessTokenProvider", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let store: SecretStore;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    store = new SecretStore(db, generateMasterKey());
    void db;
  });
  afterEach(() => {
    sqlite.close();
  });

  it("hands out only the access token", async () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "A",
      refreshToken: "R",
      expiresAt: Date.now() + 60_000,
      email: "someone@example.com",
    });
    const provider = makeAccessTokenProvider(store, "openai");
    expect(await provider()).toEqual({ accessToken: "A" });
  });
});

describe("refreshing a ChatGPT sign-in", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let store: SecretStore;
  const expired = { accessToken: "A", refreshToken: "R", expiresAt: 1, clientId: "oaiapp_1" };

  beforeEach(() => {
    ({ db, sqlite } = createInMemoryDb());
    store = new SecretStore(db, generateMasterKey());
    saveOAuthTokens(store, "openai", expired);
  });
  afterEach(() => {
    sqlite.close();
  });

  it("runs one refresh at a time: a rotating token can only be spent once", async () => {
    let calls = 0;
    const fetchImpl: OAuthFetch = async () => {
      calls++;
      await new Promise((r) => setImmediate(r));
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "B", refresh_token: "R2", expires_in: 3600 }) };
    };
    const [a, b] = await Promise.all([
      getValidOAuthTokens(store, "openai", fetchImpl),
      getValidOAuthTokens(store, "openai", fetchImpl),
    ]);
    expect(calls).toBe(1);
    expect(a.accessToken).toBe("B");
    expect(b.refreshToken).toBe("R2");
    expect(loadOAuthTokens(store, "openai")?.refreshToken).toBe("R2");
  });

  it("clears tokens OpenAI has ended, and says to sign in again", async () => {
    const fetchImpl: OAuthFetch = async () => ({ ok: false, status: 400, text: async () => '{"error":"refresh_token_reused"}' });
    await expect(getValidOAuthTokens(store, "openai", fetchImpl)).rejects.toThrow(/foreman llm login openai/);
    expect(loadOAuthTokens(store, "openai")).toBeNull();
  });

  it("keeps tokens through a network failure", async () => {
    const fetchImpl: OAuthFetch = async () => {
      throw new Error("offline");
    };
    await expect(getValidOAuthTokens(store, "openai", fetchImpl)).rejects.toThrow(/offline/);
    expect(loadOAuthTokens(store, "openai")?.refreshToken).toBe("R");
  });
});
