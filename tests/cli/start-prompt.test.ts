import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStartChoice, readStartChoice } from "../../src/cli/start.js";

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

describe("readStartChoice", () => {
  const prompt = () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough() });
    return { input, rl };
  };
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("returns the typed answer", async () => {
    const { input, rl } = prompt();
    const choice = readStartChoice(rl);
    input.write("s\n");
    await expect(choice).resolves.toBe("skip");
    expect(process.exitCode).toBeUndefined();
  });

  // Ctrl-C used to be swallowed by readline: nothing was left to run and
  // Node exited 13 with an "unsettled top-level await" warning.
  it("quits with exit code 130 on Ctrl-C", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { rl } = prompt();
    const choice = readStartChoice(rl);
    rl.emit("SIGINT");
    await expect(choice).resolves.toBe("quit");
    expect(process.exitCode).toBe(130);
  });

  it("quits on end of input (Ctrl-D) instead of hanging", async () => {
    const { input, rl } = prompt();
    const choice = readStartChoice(rl);
    input.end();
    await expect(choice).resolves.toBe("quit");
    expect(process.exitCode).toBeUndefined();
  });
});
