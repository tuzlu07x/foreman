import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generatePkce,
  generateState,
} from "../../../../src/core/llm/oauth/pkce.js";

describe("generatePkce", () => {
  it("produces a 43-char base64url verifier (32 random bytes, no padding)", () => {
    const { verifier } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBe(43);
  });

  it("produces a challenge equal to base64url(SHA-256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("returns a fresh pair on every call", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("generateState", () => {
  it("returns a 32-hex-char value", () => {
    expect(generateState()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a different value on every call", () => {
    expect(generateState()).not.toBe(generateState());
  });
});
