import { describe, expect, it } from "vitest";
import {
  applySecretsPickerSubmit,
  applySecretsValueSubmit,
} from "../../src/tui/setup-wizard.js";

describe("applySecretsPickerSubmit", () => {
  it("transitions to summary when no secrets were selected", () => {
    const result = applySecretsPickerSubmit([]);
    expect(result.nextPhase).toBe("summary");
    expect(result.selected).toEqual([]);
  });

  it("transitions to values phase when one secret is selected", () => {
    const result = applySecretsPickerSubmit(["anthropic-key"]);
    expect(result.nextPhase).toBe("values");
    expect(result.selected).toEqual(["anthropic-key"]);
  });

  it("transitions to values phase when multiple secrets are selected", () => {
    const result = applySecretsPickerSubmit([
      "anthropic-key",
      "openai-key",
      "gemini-api-key",
    ]);
    expect(result.nextPhase).toBe("values");
    expect(result.selected).toEqual([
      "anthropic-key",
      "openai-key",
      "gemini-api-key",
    ]);
  });
});

describe("applySecretsValueSubmit", () => {
  it("saves the value and advances to the next key when more remain", () => {
    const result = applySecretsValueSubmit({
      name: "anthropic-key",
      value: "sk-ant-xyz",
      currentIdx: 0,
      totalSelected: 2,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.nextPhase).toBe("values");
    expect(result.nextIdx).toBe(1);
  });

  it("saves the value and transitions to summary on the last key", () => {
    const result = applySecretsValueSubmit({
      name: "openai-key",
      value: "sk-xyz",
      currentIdx: 1,
      totalSelected: 2,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(2);
  });

  it("skips with a warning when value is empty and more keys remain", () => {
    const result = applySecretsValueSubmit({
      name: "openai-key",
      value: "",
      currentIdx: 0,
      totalSelected: 2,
    });
    expect(result.shouldSave).toBe(false);
    expect(result.warning).toContain("Skipped openai-key");
    expect(result.warning).toContain("foreman secrets add openai-key");
    expect(result.nextPhase).toBe("values");
    expect(result.nextIdx).toBe(1);
  });

  it("skips with a warning when value is empty on the last key", () => {
    const result = applySecretsValueSubmit({
      name: "gemini-api-key",
      value: "",
      currentIdx: 2,
      totalSelected: 3,
    });
    expect(result.shouldSave).toBe(false);
    expect(result.warning).toContain("Skipped gemini-api-key");
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(3);
  });

  it("handles single-key selection (idx 0 of 1) as the last key", () => {
    const result = applySecretsValueSubmit({
      name: "anthropic-key",
      value: "sk-ant-xyz",
      currentIdx: 0,
      totalSelected: 1,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(1);
  });
});
