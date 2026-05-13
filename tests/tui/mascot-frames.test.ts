import { describe, expect, it } from "vitest";
import {
  blockFallbackFrame,
  buildMorphFrame,
  MORPH_GLYPHS,
  pickChafaBlinkAsset,
  pickChafaSize,
} from "../../src/tui/components/mascot-frames.js";

describe("blockFallbackFrame", () => {
  it("returns a non-empty multi-line frame with consistent width", () => {
    const frame = blockFallbackFrame(false);
    expect(frame.lines.length).toBeGreaterThanOrEqual(8);
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBe(frame.lines.length);
  });

  it("blink variant differs from normal in the eye row", () => {
    const normal = blockFallbackFrame(false).lines;
    const blink = blockFallbackFrame(true).lines;
    expect(normal.length).toBe(blink.length);
    const diff = normal.filter((line, i) => line !== blink[i]);
    expect(diff.length).toBe(1);
    expect(diff[0]).toContain("●");
  });
});

describe("buildMorphFrame", () => {
  it("replaces non-space characters with the chosen glyph", () => {
    const target = ["  ▓██▓  ", " ▓████▓ "];
    const out = buildMorphFrame(target, 0);
    expect(out[0]).toBe(`  ${"░".repeat(4)}  `);
    expect(out[1]).toBe(` ${"░".repeat(6)} `);
  });

  it("preserves space layout across all morph stages", () => {
    const target = ["█▀█", "▄ ▄"];
    for (let i = 0; i < MORPH_GLYPHS.length; i++) {
      const frame = buildMorphFrame(target, i);
      expect(frame[0]?.length).toBe(target[0]?.length);
      expect(frame[1]?.length).toBe(target[1]?.length);
      expect(frame[1]?.charAt(1)).toBe(" ");
    }
  });

  it("clamps glyphIdx past the last value to the final glyph", () => {
    const target = ["█"];
    const out = buildMorphFrame(target, 99);
    expect(out[0]).toBe(MORPH_GLYPHS[MORPH_GLYPHS.length - 1]);
  });
});

describe("pickChafaSize", () => {
  it.each([
    [120, "terminal-large.png"],
    [100, "terminal-large.png"],
    [99, "terminal-medium.png"],
    [60, "terminal-medium.png"],
    [59, "terminal-small.png"],
    [40, "terminal-small.png"],
  ])("termCols=%i → %s", (cols, asset) => {
    expect(pickChafaSize(cols).asset).toBe(asset);
  });

  it("returns positive cols and rows for every tier", () => {
    for (const cols of [40, 60, 100, 200]) {
      const pick = pickChafaSize(cols);
      expect(pick.cols).toBeGreaterThan(0);
      expect(pick.rows).toBeGreaterThan(0);
    }
  });
});

describe("pickChafaBlinkAsset", () => {
  it("returns a blink asset for large and medium tiers, null for small", () => {
    expect(pickChafaBlinkAsset(120)).toBe("terminal-large-blink.png");
    expect(pickChafaBlinkAsset(80)).toBe("terminal-medium-blink.png");
    expect(pickChafaBlinkAsset(40)).toBe(null);
  });
});
