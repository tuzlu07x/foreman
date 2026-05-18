import { sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateKeypair,
  privateKeyObjectFromRaw,
} from "../../src/identity/keypair.js";
import { verifyRegistrySignature } from "../../src/core/registry-sign.js";

// =============================================================================
// #421 — Registry signature verification. Wraps Node's crypto.verify with
// typed errors so the CLI can surface clean messages without try/catch noise.
// =============================================================================

function signBody(body: Buffer, privateKey: Buffer): string {
  // Mirror the upstream signer: Ed25519 detached signature over the raw
  // body bytes, hex-encoded.
  const sig = sign(null, body, privateKeyObjectFromRaw(privateKey));
  return Buffer.from(sig).toString("hex");
}

describe("verifyRegistrySignature", () => {
  it("verifies a fresh Ed25519 signature with the matching public key", () => {
    const kp = generateKeypair();
    const body = Buffer.from('{"version":1,"agents":[]}', "utf-8");
    const signatureHex = signBody(body, kp.privateKey);
    const result = verifyRegistrySignature({
      body,
      signatureHex,
      publicKeyHex: kp.publicKey.toString("hex"),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects a signature signed by a different key", () => {
    const signer = generateKeypair();
    const other = generateKeypair();
    const body = Buffer.from('{"version":1,"agents":[]}', "utf-8");
    const signatureHex = signBody(body, signer.privateKey);
    const result = verifyRegistrySignature({
      body,
      signatureHex,
      publicKeyHex: other.publicKey.toString("hex"), // wrong key
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not verify/);
  });

  it("rejects when the body is tampered with after signing", () => {
    const kp = generateKeypair();
    const original = Buffer.from('{"version":1,"agents":[]}', "utf-8");
    const signatureHex = signBody(original, kp.privateKey);
    const tampered = Buffer.from(
      '{"version":1,"agents":[{"id":"evil"}]}',
      "utf-8",
    );
    const result = verifyRegistrySignature({
      body: tampered,
      signatureHex,
      publicKeyHex: kp.publicKey.toString("hex"),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed hex signatures (wrong length)", () => {
    const result = verifyRegistrySignature({
      body: Buffer.from("hi"),
      signatureHex: "abcd", // 4 hex chars = 2 bytes, not 64
      publicKeyHex: "00".repeat(32),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/64 bytes of hex/);
  });

  it("rejects malformed hex public keys (wrong length)", () => {
    const result = verifyRegistrySignature({
      body: Buffer.from("hi"),
      signatureHex: "00".repeat(64),
      publicKeyHex: "abcd",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/32 bytes of hex/);
  });

  it("rejects non-hex characters in signature", () => {
    const result = verifyRegistrySignature({
      body: Buffer.from("hi"),
      signatureHex: "z".repeat(128), // 128 chars but not hex
      publicKeyHex: "00".repeat(32),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hex/);
  });

  it("trims whitespace from signature + key (tolerates trailing newlines from curl)", () => {
    const kp = generateKeypair();
    const body = Buffer.from("hello", "utf-8");
    const signatureHex = signBody(body, kp.privateKey);
    const result = verifyRegistrySignature({
      body,
      signatureHex: signatureHex + "\n", // curl-style trailing newline
      publicKeyHex: kp.publicKey.toString("hex") + "\n",
    });
    expect(result.ok).toBe(true);
  });
});
