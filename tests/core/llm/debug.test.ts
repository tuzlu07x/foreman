import { describe, expect, it, vi } from "vitest";
import { debugLogLlmError, isLlmDebugEnabled } from "../../../src/core/llm/debug.js";

describe("isLlmDebugEnabled", () => {
  it("returns false when FOREMAN_LLM_DEBUG is unset", () => {
    expect(isLlmDebugEnabled({})).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLlmDebugEnabled({ FOREMAN_LLM_DEBUG: "" })).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", " 1 "])("returns true for %s", (value) => {
    expect(isLlmDebugEnabled({ FOREMAN_LLM_DEBUG: value })).toBe(true);
  });

  it.each(["0", "false", "no", "off"])("returns false for %s", (value) => {
    expect(isLlmDebugEnabled({ FOREMAN_LLM_DEBUG: value })).toBe(false);
  });
});

describe("debugLogLlmError", () => {
  it("is a no-op when the env flag is off", () => {
    const write = vi.fn();
    debugLogLlmError("verifier", new Error("boom"), { env: {}, write });
    expect(write).not.toHaveBeenCalled();
  });

  it("writes a single stderr line when enabled", () => {
    const write = vi.fn();
    debugLogLlmError("verifier", new Error("openai 429 rate limited"), {
      env: { FOREMAN_LLM_DEBUG: "1" },
      write,
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toBe(
      "[foreman llm:verifier] openai 429 rate limited\n",
    );
  });

  it("stringifies non-Error throwables", () => {
    const write = vi.fn();
    debugLogLlmError("summary", { code: "ETIMEDOUT" }, {
      env: { FOREMAN_LLM_DEBUG: "1" },
      write,
    });
    expect(write).toHaveBeenCalledOnce();
    const line = write.mock.calls[0][0];
    expect(line).toContain("[foreman llm:summary]");
  });

  it("tags the context so multiple debug lines stay distinguishable", () => {
    const write = vi.fn();
    debugLogLlmError("budget", new Error("over cap"), {
      env: { FOREMAN_LLM_DEBUG: "yes" },
      write,
    });
    expect(write.mock.calls[0][0]).toContain("llm:budget");
  });
});
