import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configuredProviderIds,
  configuredServiceIds,
  countPolicyRules,
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

describe("configuredProviderIds", () => {
  it("returns provider ids whose secret_name is stored", () => {
    const anthropic = provider({ id: "anthropic" });
    const openai = provider({ id: "openai", secret_name: "openai-api-key" });
    const stored = new Set(["anthropic-api-key"]);
    expect(configuredProviderIds([anthropic, openai], stored)).toEqual([
      "anthropic",
    ]);
  });

  it("recognizes endpoint-only providers via '<id>-endpoint'", () => {
    const ollama = provider({
      id: "ollama",
      secret_name: null,
      endpoint_required: true,
      endpoint_default: "http://localhost:11434",
    });
    const stored = new Set(["ollama-endpoint"]);
    expect(configuredProviderIds([ollama], stored)).toEqual(["ollama"]);
  });

  it("recognizes endpoint+key providers when either is stored", () => {
    const custom = provider({
      id: "openai-compatible",
      secret_name: "openai-compatible-api-key",
      endpoint_required: true,
    });
    expect(
      configuredProviderIds([custom], new Set(["openai-compatible-api-key"])),
    ).toEqual(["openai-compatible"]);
    expect(
      configuredProviderIds([custom], new Set(["openai-compatible-endpoint"])),
    ).toEqual(["openai-compatible"]);
  });

  it("returns empty when nothing matches", () => {
    const anthropic = provider({ id: "anthropic" });
    expect(configuredProviderIds([anthropic], new Set())).toEqual([]);
  });
});

describe("configuredServiceIds", () => {
  it("returns service ids whose secret_name is in the store", () => {
    const services = [
      { id: "telegram", secret_name: "telegram-bot-token" },
      { id: "github", secret_name: "github-pat" },
    ];
    expect(
      configuredServiceIds(services, new Set(["github-pat"])),
    ).toEqual(["github"]);
  });

  it("returns empty when no matches", () => {
    const services = [{ id: "telegram", secret_name: "telegram-bot-token" }];
    expect(configuredServiceIds(services, new Set())).toEqual([]);
  });
});

describe("countPolicyRules", () => {
  let tmpDir: string;
  let policyPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-policy-"));
    policyPath = join(tmpDir, "policy.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 when the file does not exist", () => {
    expect(countPolicyRules(policyPath)).toBe(0);
  });

  it("counts rules in a well-formed policy.yaml", () => {
    writeFileSync(
      policyPath,
      `rules:
  - source: "*"
    target: "tool:read_file"
    effect: ask
  - source: "*"
    target: "tool:shell_exec"
    effect: ask
  - source: "agent:claude-code"
    target: "tool:write_file"
    effect: allow
`,
    );
    expect(countPolicyRules(policyPath)).toBe(3);
  });

  it("returns 0 when rules is missing", () => {
    writeFileSync(policyPath, `something_else: true\n`);
    expect(countPolicyRules(policyPath)).toBe(0);
  });

  it("returns 0 on malformed yaml", () => {
    writeFileSync(policyPath, `rules: [unbalanced\n`);
    expect(countPolicyRules(policyPath)).toBe(0);
  });

  it("returns 0 when rules is not an array", () => {
    writeFileSync(policyPath, `rules: not-a-list\n`);
    expect(countPolicyRules(policyPath)).toBe(0);
  });
});
