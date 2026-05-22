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
    await expect(getValidOAuthTokens(store, "anthropic")).rejects.toThrow(
      /Not signed in/,
    );
  });

  it("returns the stored bundle when it is still valid", async () => {
    const now = Date.now();
    saveOAuthTokens(store, "anthropic", {
      accessToken: "A",
      refreshToken: "R",
      expiresAt: now + 60_000,
    });
    const tokens = await getValidOAuthTokens(
      store,
      "anthropic",
      undefined,
      now,
    );
    expect(tokens.accessToken).toBe("A");
  });

  it("refreshes and persists when the stored bundle is stale", async () => {
    saveOAuthTokens(store, "anthropic", {
      accessToken: "OLD",
      refreshToken: "R-OLD",
      expiresAt: 1, // long ago
    });
    const fetchImpl = mockFetch({
      access_token: "NEW",
      refresh_token: "R-NEW",
      expires_in: 600,
    });
    const tokens = await getValidOAuthTokens(store, "anthropic", fetchImpl);
    expect(tokens.accessToken).toBe("NEW");
    expect(tokens.refreshToken).toBe("R-NEW");
    // Persisted to the store.
    expect(loadOAuthTokens(store, "anthropic")?.accessToken).toBe("NEW");
  });

  it("treats exactly-expired as stale (>= expiresAt)", async () => {
    const t = 1_000_000;
    saveOAuthTokens(store, "anthropic", {
      accessToken: "OLD",
      refreshToken: "R",
      expiresAt: t,
    });
    const fetchImpl = mockFetch({
      access_token: "NEW",
      refresh_token: "R2",
      expires_in: 600,
    });
    const tokens = await getValidOAuthTokens(store, "anthropic", fetchImpl, t);
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

  it("yields a credential with accountId when present (Codex)", async () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "A",
      refreshToken: "R",
      expiresAt: Date.now() + 60_000,
      accountId: "acc-1",
    });
    const provider = makeAccessTokenProvider(store, "openai");
    expect(await provider()).toEqual({ accessToken: "A", accountId: "acc-1" });
  });

  it("omits accountId when absent (Anthropic)", async () => {
    saveOAuthTokens(store, "anthropic", {
      accessToken: "A",
      refreshToken: "R",
      expiresAt: Date.now() + 60_000,
    });
    const provider = makeAccessTokenProvider(store, "anthropic");
    expect(await provider()).toEqual({ accessToken: "A" });
  });
});
