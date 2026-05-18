import { describe, expect, it } from "vitest";
import {
  findPreset,
  loadLlmPresets,
  _resetLlmPresetsCache,
} from "../../src/core/llm-provider-presets.js";

describe("loadLlmPresets", () => {
  it("loads the bundled presets and includes the five round-3 providers", () => {
    _resetLlmPresetsCache();
    const doc = loadLlmPresets();
    expect(doc.version).toBe(1);
    expect(doc.presets.length).toBeGreaterThanOrEqual(5);
    const ids = doc.presets.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "deepseek",
        "qwen-dashscope",
        "openrouter",
        "together",
        "groq",
      ]),
    );
  });

  it("caches on second call", () => {
    _resetLlmPresetsCache();
    const a = loadLlmPresets();
    const b = loadLlmPresets();
    expect(a).toBe(b);
  });

  it("every preset has a valid endpoint URL + key_secret_name + default_model", () => {
    _resetLlmPresetsCache();
    const doc = loadLlmPresets();
    for (const p of doc.presets) {
      expect(p.endpoint).toMatch(/^https?:\/\//);
      expect(p.key_secret_name).toMatch(/-api-key$/);
      expect(p.default_model.length).toBeGreaterThan(0);
      expect(p.where_to_get).toMatch(/^https?:\/\//);
      expect(p.cost_hint.length).toBeGreaterThan(0);
    }
  });
});

describe("findPreset", () => {
  it("returns the preset by id", () => {
    const doc = loadLlmPresets();
    const ds = findPreset(doc, "deepseek");
    expect(ds).not.toBeNull();
    expect(ds?.endpoint).toContain("deepseek.com");
  });

  it("returns null for an unknown id", () => {
    const doc = loadLlmPresets();
    expect(findPreset(doc, "nonexistent")).toBeNull();
  });
});
