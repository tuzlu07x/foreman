import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "../../../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../../../src/db/client.js";
import { generateMasterKey } from "../../../../src/identity/encryption.js";
import {
  removeLegacyChatgptTokens,
  clearOAuthTokens,
  loadOAuthTokens,
  oauthSecretName,
  saveOAuthTokens,
} from "../../../../src/core/llm/oauth/token-store.js";

describe("OAuth token store", () => {
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

  it("round-trips a full token bundle (save → load)", () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 12345,
      email: "acc",
    });
    expect(loadOAuthTokens(store, "openai")).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 12345,
      email: "acc",
    });
  });

  it("omits email on load when none was stored (Anthropic case)", () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "sk-ant-oat",
      refreshToken: "rt",
      expiresAt: 1,
    });
    const loaded = loadOAuthTokens(store, "openai");
    expect(loaded).toEqual({
      accessToken: "sk-ant-oat",
      refreshToken: "rt",
      expiresAt: 1,
    });
    expect(loaded?.email).toBeUndefined();
  });

  it("returns null when no bundle is stored", () => {
    expect(loadOAuthTokens(store, "openai")).toBeNull();
  });

  it("overwrites on a second save (rotate, not duplicate-add)", () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 1,
    });
    saveOAuthTokens(store, "openai", {
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 2,
    });
    expect(loadOAuthTokens(store, "openai")?.accessToken).toBe("a2");
  });

  it("encrypts at rest — DB row has no plaintext token", () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "VERY_SECRET_TOKEN_xyz",
      refreshToken: "rt",
      expiresAt: 1,
    });
    const row = sqlite
      .prepare("SELECT value_encrypted FROM secrets WHERE name = ?")
      .get(oauthSecretName("openai")) as { value_encrypted: Buffer };
    expect(row.value_encrypted.toString("utf8")).not.toContain(
      "VERY_SECRET_TOKEN_xyz",
    );
  });

  it("clearOAuthTokens removes the bundle and is a no-op when absent", () => {
    saveOAuthTokens(store, "openai", {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
    });
    clearOAuthTokens(store, "openai");
    expect(loadOAuthTokens(store, "openai")).toBeNull();
    expect(() => clearOAuthTokens(store, "openai")).not.toThrow();
  });

  it("throws on a corrupted stored bundle", () => {
    store.add(oauthSecretName("openai"), "not-json-{");
    expect(() => loadOAuthTokens(store, "openai")).toThrow(/corrupt/);
  });

  it("throws when stored bundle is missing required fields", () => {
    store.add(oauthSecretName("openai"), '{"accessToken":"only"}');
    expect(() => loadOAuthTokens(store, "openai")).toThrow(/missing fields/);
  });
});

describe("removeLegacyChatgptTokens", () => {
  const seeded = (value: string) => {
    const data = new Map([["llm-oauth-openai", value]]);
    return {
      data,
      exists: (n: string) => data.has(n),
      get: (n: string) => data.get(n)!,
      remove: (n: string) => void data.delete(n),
    };
  };
  const bundle = { accessToken: "A", refreshToken: "R", expiresAt: 1 };

  it("drops tokens from before Foreman had its own registration", () => {
    const store = seeded(JSON.stringify(bundle));
    expect(removeLegacyChatgptTokens(store)).toBe(true);
    expect(store.data.size).toBe(0);
  });

  it("leaves a current sign-in alone", () => {
    const store = seeded(JSON.stringify({ ...bundle, clientId: "oaiapp_1" }));
    expect(removeLegacyChatgptTokens(store)).toBe(false);
    expect(store.data.size).toBe(1);
  });
});
