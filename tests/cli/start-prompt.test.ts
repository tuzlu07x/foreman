import { describe, expect, it } from "vitest";
import { parseStartChoice } from "../../src/cli/start.js";

describe("parseStartChoice", () => {
  it("returns 'setup' for empty input (Enter is the affordance)", () => {
    expect(parseStartChoice("")).toBe("setup");
  });

  it("returns 'setup' for whitespace-only input", () => {
    expect(parseStartChoice("   ")).toBe("setup");
  });

  it("returns 'skip' for 's' / 'S'", () => {
    expect(parseStartChoice("s")).toBe("skip");
    expect(parseStartChoice("S")).toBe("skip");
    expect(parseStartChoice("  s  ")).toBe("skip");
  });

  it("returns 'quit' for 'q' / 'Q'", () => {
    expect(parseStartChoice("q")).toBe("quit");
    expect(parseStartChoice("Q")).toBe("quit");
    expect(parseStartChoice("q\n")).toBe("quit");
  });

  it("treats any other input as 'setup' (Enter default semantics)", () => {
    expect(parseStartChoice("yes")).toBe("setup");
    expect(parseStartChoice("setup")).toBe("setup");
    expect(parseStartChoice("xyz")).toBe("setup");
  });
});
