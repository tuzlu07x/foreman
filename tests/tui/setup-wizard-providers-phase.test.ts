import { describe, expect, it } from "vitest";
import {
  applyProviderValueSubmit,
  applyProvidersPickerSubmit,
  buildProviderPromptList,
  storageNameForPrompt,
} from "../../src/tui/setup-wizard.js";
import type { ProviderEntry } from "../../src/core/registry-catalog.js";

function provider(overrides: Partial<ProviderEntry>): ProviderEntry {
  return {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models",
    secret_name: "anthropic-api-key",
    where_to_get: "https://example.com",
    format_hint: "starts with sk-",
    instructions: ["one"],
    endpoint_default: null,
    endpoint_required: false,
    ...overrides,
  };
}

describe("applyProvidersPickerSubmit", () => {
  it("transitions to summary when no providers were selected", () => {
    const result = applyProvidersPickerSubmit([]);
    expect(result.nextPhase).toBe("summary");
    expect(result.selected).toEqual([]);
  });

  it("transitions to values phase when one provider is selected", () => {
    const result = applyProvidersPickerSubmit(["anthropic"]);
    expect(result.nextPhase).toBe("values");
    expect(result.selected).toEqual(["anthropic"]);
  });

  it("preserves selection order", () => {
    const result = applyProvidersPickerSubmit(["openai", "anthropic"]);
    expect(result.selected).toEqual(["openai", "anthropic"]);
  });
});

describe("buildProviderPromptList", () => {
  const anthropic = provider({ id: "anthropic" });
  const openai = provider({ id: "openai", secret_name: "openai-api-key" });
  const ollama = provider({
    id: "ollama",
    secret_name: null,
    endpoint_default: "http://localhost:11434",
    endpoint_required: true,
  });
  const custom = provider({
    id: "openai-compatible",
    secret_name: "openai-compatible-api-key",
    endpoint_default: null,
    endpoint_required: true,
  });

  const catalog: ProviderEntry[] = [anthropic, openai, ollama, custom];

  it("emits a single key prompt for an API-key-only provider", () => {
    const prompts = buildProviderPromptList(catalog, ["anthropic"]);
    expect(prompts).toEqual([{ providerId: "anthropic", kind: "key" }]);
  });

  it("emits a single endpoint prompt for an endpoint-only provider", () => {
    const prompts = buildProviderPromptList(catalog, ["ollama"]);
    expect(prompts).toEqual([{ providerId: "ollama", kind: "endpoint" }]);
  });

  it("emits endpoint then key for a custom provider needing both", () => {
    const prompts = buildProviderPromptList(catalog, ["openai-compatible"]);
    expect(prompts).toEqual([
      { providerId: "openai-compatible", kind: "endpoint" },
      { providerId: "openai-compatible", kind: "key" },
    ]);
  });

  it("flattens a mixed selection in selection order", () => {
    const prompts = buildProviderPromptList(catalog, [
      "anthropic",
      "ollama",
      "openai-compatible",
    ]);
    expect(prompts).toEqual([
      { providerId: "anthropic", kind: "key" },
      { providerId: "ollama", kind: "endpoint" },
      { providerId: "openai-compatible", kind: "endpoint" },
      { providerId: "openai-compatible", kind: "key" },
    ]);
  });

  it("skips selections that aren't in the catalog (defensive)", () => {
    const prompts = buildProviderPromptList(catalog, ["ghost", "anthropic"]);
    expect(prompts).toEqual([{ providerId: "anthropic", kind: "key" }]);
  });
});

describe("storageNameForPrompt", () => {
  it("uses the provider's secret_name for key prompts", () => {
    const p = provider({ id: "anthropic", secret_name: "anthropic-api-key" });
    expect(
      storageNameForPrompt({ providerId: "anthropic", kind: "key" }, p),
    ).toBe("anthropic-api-key");
  });

  it("uses '<id>-endpoint' for endpoint prompts", () => {
    const p = provider({
      id: "ollama",
      secret_name: null,
      endpoint_required: true,
    });
    expect(
      storageNameForPrompt({ providerId: "ollama", kind: "endpoint" }, p),
    ).toBe("ollama-endpoint");
  });

  it("throws when a key prompt asks for a provider with no secret_name", () => {
    const p = provider({ id: "ollama", secret_name: null });
    expect(() =>
      storageNameForPrompt({ providerId: "ollama", kind: "key" }, p),
    ).toThrow();
  });
});

describe("applyProviderValueSubmit", () => {
  it("saves the value and advances when more prompts remain", () => {
    const result = applyProviderValueSubmit({
      prompt: { providerId: "anthropic", kind: "key" },
      value: "sk-ant-xyz",
      currentIdx: 0,
      totalPrompts: 2,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.nextPhase).toBe("values");
    expect(result.nextIdx).toBe(1);
  });

  it("saves and transitions to summary on the last prompt", () => {
    const result = applyProviderValueSubmit({
      prompt: { providerId: "openai", kind: "key" },
      value: "sk-xyz",
      currentIdx: 1,
      totalPrompts: 2,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(2);
  });

  it("skips a key prompt with a warning when value is empty", () => {
    const result = applyProviderValueSubmit({
      prompt: { providerId: "openai", kind: "key" },
      value: "",
      currentIdx: 0,
      totalPrompts: 2,
    });
    expect(result.shouldSave).toBe(false);
    expect(result.warning).toContain("Skipped openai key");
    expect(result.nextPhase).toBe("values");
    expect(result.nextIdx).toBe(1);
  });

  it("skips an endpoint prompt with a warning when value is empty (mid-loop)", () => {
    const result = applyProviderValueSubmit({
      prompt: { providerId: "ollama", kind: "endpoint" },
      value: "",
      currentIdx: 1,
      totalPrompts: 3,
    });
    expect(result.shouldSave).toBe(false);
    expect(result.warning).toContain("Skipped ollama endpoint");
    expect(result.nextPhase).toBe("values");
    expect(result.nextIdx).toBe(2);
  });

  it("skips on the last prompt transitions to summary", () => {
    const result = applyProviderValueSubmit({
      prompt: { providerId: "ollama", kind: "endpoint" },
      value: "",
      currentIdx: 2,
      totalPrompts: 3,
    });
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(3);
  });

  it("handles single-prompt selection (idx 0 of 1)", () => {
    const result = applyProviderValueSubmit({
      prompt: { providerId: "anthropic", kind: "key" },
      value: "sk-ant-xyz",
      currentIdx: 0,
      totalPrompts: 1,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(1);
  });
});
