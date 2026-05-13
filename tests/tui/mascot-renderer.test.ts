import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  __resetChafaCache,
  detectChafa,
  resolveMascotAsset,
} from "../../src/tui/components/mascot-renderer.js";

describe("detectChafa", () => {
  it("caches its result across calls", () => {
    __resetChafaCache();
    const first = detectChafa();
    const second = detectChafa();
    expect(first).toBe(second);
    expect(typeof first).toBe("boolean");
  });
});

describe("resolveMascotAsset", () => {
  it("resolves a real asset that exists on disk", () => {
    const path = resolveMascotAsset("terminal-large.png");
    expect(path).not.toBeNull();
    if (path) expect(existsSync(path)).toBe(true);
  });

  it("returns null for a non-existent asset", () => {
    expect(resolveMascotAsset("definitely-not-a-real-asset.png")).toBe(null);
  });
});
