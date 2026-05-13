import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decrypt,
  encrypt,
  EncryptionError,
  generateMasterKey,
} from "../../src/identity/encryption.js";

describe("encryption", () => {
  it("round-trips utf8 plaintext through encrypt/decrypt", () => {
    const key = generateMasterKey();
    const payload = encrypt("anthropic-sk-abc123-türkçe-✓", key);
    expect(payload.iv.length).toBe(12);
    expect(payload.authTag.length).toBe(16);
    expect(payload.ciphertext.toString("utf8")).not.toBe(
      "anthropic-sk-abc123-türkçe-✓",
    );
    expect(decrypt(payload, key)).toBe("anthropic-sk-abc123-türkçe-✓");
  });

  it("generates a different iv per encryption", () => {
    const key = generateMasterKey();
    const a = encrypt("same", key);
    const b = encrypt("same", key);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("throws EncryptionError when decrypted with the wrong key", () => {
    const key1 = generateMasterKey();
    const key2 = generateMasterKey();
    const payload = encrypt("secret", key1);
    expect(() => decrypt(payload, key2)).toThrow(EncryptionError);
  });

  it("throws EncryptionError when ciphertext is tampered", () => {
    const key = generateMasterKey();
    const payload = encrypt("secret-value", key);
    payload.ciphertext[0] = (payload.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decrypt(payload, key)).toThrow(EncryptionError);
  });

  it("rejects keys that are not 32 bytes", () => {
    const shortKey = randomBytes(16);
    expect(() => encrypt("x", shortKey)).toThrow(EncryptionError);
  });
});

describe("generateMasterKey", () => {
  it("emits a 32-byte buffer", () => {
    expect(generateMasterKey().length).toBe(32);
  });
});
