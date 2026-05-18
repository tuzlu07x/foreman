import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectProviderConflict,
  formatConflictWarning,
} from "../../src/core/agent-provider-conflict.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";

function fakeEntry(
  overrides: Partial<AgentEntry["secret_projection"]> = {},
): AgentEntry {
  return {
    id: "hermes",
    name: "Hermes",
    tagline: "t",
    homepage: "https://example.com/",
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: "*",
    min_foreman_version: "0.1.2",
    secret_projection: overrides as AgentEntry["secret_projection"],
  } as AgentEntry;
}

describe("detectProviderConflict", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "foreman-provider-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(relPath: string, content: string): void {
    const abs = join(home, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  it("returns null when the agent has no provider_check block", () => {
    const result = detectProviderConflict(fakeEntry(), "openai", { home });
    expect(result).toBeNull();
  });

  it("returns null when the config file doesn't exist (fresh install)", () => {
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.hermes/config.yaml",
          format: "yaml",
          key: "provider",
        },
      }),
      "openai",
      { home },
    );
    expect(result).toBeNull();
  });

  it("returns a conflict when YAML provider differs from foreman", () => {
    writeConfig(".hermes/config.yaml", "provider: openrouter\nmodel: gpt-4\n");
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.hermes/config.yaml",
          format: "yaml",
          key: "provider",
          fix_command: "hermes model",
        },
      }),
      "openai",
      { home },
    );
    expect(result).not.toBeNull();
    expect(result!.configProvider).toBe("openrouter");
    expect(result!.foremanProvider).toBe("openai");
    expect(result!.fixCommand).toBe("hermes model");
    expect(result!.configPath).toContain(".hermes/config.yaml");
  });

  it("returns null when YAML provider matches foreman", () => {
    writeConfig(".hermes/config.yaml", "provider: openai\n");
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.hermes/config.yaml",
          format: "yaml",
          key: "provider",
        },
      }),
      "openai",
      { home },
    );
    expect(result).toBeNull();
  });

  it("returns null when the provider field is missing from the config", () => {
    writeConfig(".hermes/config.yaml", "model: gpt-4\n");
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.hermes/config.yaml",
          format: "yaml",
          key: "provider",
        },
      }),
      "openai",
      { home },
    );
    expect(result).toBeNull();
  });

  it("returns null when YAML parsing fails", () => {
    writeConfig(".hermes/config.yaml", ":\n  not: [valid yaml: at all");
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.hermes/config.yaml",
          format: "yaml",
          key: "provider",
        },
      }),
      "openai",
      { home },
    );
    expect(result).toBeNull();
  });

  it("returns a conflict for JSON configs (OpenClaw)", () => {
    writeConfig(
      ".openclaw/openclaw.json",
      JSON.stringify({ provider: "anthropic", model: "claude-3" }),
    );
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.openclaw/openclaw.json",
          format: "json",
          key: "provider",
        },
      }),
      "openai",
      { home },
    );
    expect(result!.configProvider).toBe("anthropic");
    expect(result!.foremanProvider).toBe("openai");
  });

  it("supports nested dot-path keys", () => {
    writeConfig(
      ".openclaw/openclaw.json",
      JSON.stringify({ llm: { provider: "gemini" } }),
    );
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.openclaw/openclaw.json",
          format: "json",
          key: "llm.provider",
        },
      }),
      "openai",
      { home },
    );
    expect(result!.configProvider).toBe("gemini");
  });

  it("returns null when JSON parsing fails", () => {
    writeConfig(".openclaw/openclaw.json", "{ not json");
    const result = detectProviderConflict(
      fakeEntry({
        provider_check: {
          path: "~/.openclaw/openclaw.json",
          format: "json",
          key: "provider",
        },
      }),
      "openai",
      { home },
    );
    expect(result).toBeNull();
  });
});

describe("formatConflictWarning", () => {
  it("includes the fix command when present", () => {
    const lines = formatConflictWarning({
      agentId: "hermes",
      configPath: "/home/u/.hermes/config.yaml",
      configProvider: "openrouter",
      foremanProvider: "openai",
      fixCommand: "hermes model",
    });
    expect(lines.join("\n")).toContain("openrouter");
    expect(lines.join("\n")).toContain("openai");
    expect(lines.join("\n")).toContain("hermes model");
  });

  it("falls back to a generic edit hint when fixCommand is null", () => {
    const lines = formatConflictWarning({
      agentId: "openclaw",
      configPath: "/home/u/.openclaw/openclaw.json",
      configProvider: "anthropic",
      foremanProvider: "openai",
      fixCommand: null,
    });
    expect(lines.join("\n")).toMatch(/edit/i);
    expect(lines.join("\n")).toContain("openai");
  });
});
