import { describe, expect, it } from "vitest";
import { osc8 } from "../../src/tui/osc8.js";

const ESC = "\x1B";

describe("osc8", () => {
  it("wraps a URL with the OSC 8 hyperlink escape sequence", () => {
    const result = osc8("https://example.com");
    expect(result).toBe(
      `${ESC}]8;;https://example.com${ESC}\\https://example.com${ESC}]8;;${ESC}\\`,
    );
  });

  it("uses the provided label when supplied", () => {
    const result = osc8("https://example.com", "click here");
    expect(result).toBe(
      `${ESC}]8;;https://example.com${ESC}\\click here${ESC}]8;;${ESC}\\`,
    );
  });

  it("emits a closing OSC 8 sequence so the hyperlink doesn't bleed", () => {
    const result = osc8("https://example.com", "x");
    expect(result.endsWith(`${ESC}]8;;${ESC}\\`)).toBe(true);
  });
});
