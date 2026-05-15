import { describe, expect, it } from "vitest";
import { ownershipForSecret } from "../../src/tui/pages/secrets-page.js";
import type {
  ProviderEntry,
  ServiceEntry,
} from "../../src/core/registry-catalog.js";

function provider(o: Partial<ProviderEntry>): ProviderEntry {
  return {
    id: "anthropic",
    name: "Anthropic",
    description: "x",
    secret_name: "anthropic-api-key",
    where_to_get: "https://example.com",
    format_hint: "starts with sk-",
    instructions: ["one"],
    endpoint_default: null,
    endpoint_required: false,
    ...o,
  };
}

function service(o: Partial<ServiceEntry>): ServiceEntry {
  return {
    id: "telegram",
    name: "Telegram",
    description: "x",
    secret_name: "telegram-bot-token",
    where_to_get: "https://t.me/BotFather",
    format_hint: "x",
    setup_steps: ["one"],
    used_by_agents: [],
    open_url_hotkey: false,
    ...o,
  };
}

describe("ownershipForSecret", () => {
  const providers = [
    provider({ id: "anthropic", secret_name: "anthropic-api-key" }),
    provider({ id: "openai", secret_name: "openai-api-key" }),
    provider({
      id: "ollama",
      secret_name: null,
      endpoint_required: true,
      endpoint_default: "http://localhost:11434",
    }),
  ];
  const services = [
    service({ id: "telegram", secret_name: "telegram-bot-token" }),
    service({ id: "github", secret_name: "github-pat" }),
  ];

  it("returns providers ownership for a provider secret_name match", () => {
    const result = ownershipForSecret(
      "anthropic-api-key",
      providers,
      services,
    );
    expect(result.kind).toBe("providers");
    if (result.kind === "providers") {
      expect(result.entry.id).toBe("anthropic");
    }
  });

  it("returns providers ownership for an endpoint match (<id>-endpoint)", () => {
    const result = ownershipForSecret("ollama-endpoint", providers, services);
    expect(result.kind).toBe("providers");
    if (result.kind === "providers") {
      expect(result.entry.id).toBe("ollama");
    }
  });

  it("returns services ownership for a service secret_name match", () => {
    const result = ownershipForSecret(
      "telegram-bot-token",
      providers,
      services,
    );
    expect(result.kind).toBe("services");
    if (result.kind === "services") {
      expect(result.entry.id).toBe("telegram");
    }
  });

  it("returns raw for unknown names", () => {
    expect(
      ownershipForSecret("my-custom-token", providers, services).kind,
    ).toBe("raw");
  });

  it("provider secret_name takes precedence over a same-named service", () => {
    // Defensive: if a typo creates an overlap, providers come first in the
    // function so the test pins that order as the canonical resolution.
    const overlap = [
      service({ id: "x", secret_name: "anthropic-api-key" }),
      ...services,
    ];
    const result = ownershipForSecret(
      "anthropic-api-key",
      providers,
      overlap,
    );
    expect(result.kind).toBe("providers");
  });
});
