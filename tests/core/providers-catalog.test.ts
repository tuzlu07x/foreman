import { describe, expect, it } from "vitest";
import {
  findProvider,
  loadActiveProviders,
  loadBundledProviders,
  parseProviderCatalogText,
  ProviderCatalogValidationError,
  ProviderNotInCatalogError,
} from "../../src/core/registry-catalog.js";

function freshProvider(): Record<string, unknown> {
  return {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models",
    secret_name: "anthropic-key",
    key_prefix: "sk-ant-",
    where_to_get: "https://console.anthropic.com/settings/keys",
    format_hint: "starts with sk-ant-",
    instructions: ["Step one", "Step two"],
    endpoint_default: null,
    endpoint_required: false,
  };
}

function validDoc(): Record<string, unknown> {
  return { version: 1, providers: [freshProvider()] };
}

describe("parseProviderCatalogText", () => {
  it("accepts a well-formed document and returns the typed shape", () => {
    const doc = parseProviderCatalogText(JSON.stringify(validDoc()));
    expect(doc.providers).toHaveLength(1);
    expect(doc.providers[0]?.id).toBe("anthropic");
  });

  it("rejects invalid JSON with ProviderCatalogValidationError", () => {
    expect(() => parseProviderCatalogText("{ not json")).toThrow(
      ProviderCatalogValidationError,
    );
  });

  it("rejects a missing version field", () => {
    const bad = { providers: [freshProvider()] };
    expect(() => parseProviderCatalogText(JSON.stringify(bad))).toThrow(
      ProviderCatalogValidationError,
    );
  });

  it("rejects a non-kebab-case id", () => {
    const bad = validDoc();
    (bad.providers as Record<string, unknown>[])[0]!.id = "Bad_ID";
    expect(() => parseProviderCatalogText(JSON.stringify(bad))).toThrow(
      ProviderCatalogValidationError,
    );
  });

  it("rejects when where_to_get is not a URL", () => {
    const bad = validDoc();
    (bad.providers as Record<string, unknown>[])[0]!.where_to_get = "not a url";
    expect(() => parseProviderCatalogText(JSON.stringify(bad))).toThrow(
      ProviderCatalogValidationError,
    );
  });

  it("accepts unknown fields on a provider entry (forward-compat)", () => {
    const extra = { ...freshProvider(), default_model: "claude-sonnet-4-6" };
    const doc = parseProviderCatalogText(
      JSON.stringify({ version: 1, providers: [extra] }),
    );
    expect(doc.providers[0]?.id).toBe("anthropic");
  });

  it("accepts ollama shape (no secret_name, endpoint_required true)", () => {
    const ollama = {
      ...freshProvider(),
      id: "ollama",
      name: "Local (Ollama)",
      secret_name: null,
      endpoint_default: "http://localhost:11434",
      endpoint_required: true,
    };
    const doc = parseProviderCatalogText(
      JSON.stringify({ version: 1, providers: [ollama] }),
    );
    expect(doc.providers[0]?.endpoint_required).toBe(true);
    expect(doc.providers[0]?.secret_name).toBeNull();
  });
});

describe("findProvider", () => {
  it("returns the matching entry", () => {
    const doc = parseProviderCatalogText(JSON.stringify(validDoc()));
    expect(findProvider(doc, "anthropic").name).toBe("Anthropic");
  });

  it("throws ProviderNotInCatalogError for unknown id", () => {
    const doc = parseProviderCatalogText(JSON.stringify(validDoc()));
    expect(() => findProvider(doc, "missing")).toThrow(
      ProviderNotInCatalogError,
    );
  });
});

describe("loadBundledProviders + loadActiveProviders", () => {
  it("parses the bundled registry/providers.json", () => {
    const doc = loadBundledProviders();
    expect(doc.version).toBe(1);
    expect(doc.providers.length).toBeGreaterThan(0);
  });

  it("includes the five tier-1 providers", () => {
    const doc = loadBundledProviders();
    const ids = doc.providers.map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("gemini");
    expect(ids).toContain("ollama");
    expect(ids).toContain("openai-compatible");
  });

  it("loadActiveProviders reports the source as bundled", () => {
    const result = loadActiveProviders();
    expect(result.source).toBe("bundled");
    expect(result.doc.providers.length).toBeGreaterThan(0);
  });
});
