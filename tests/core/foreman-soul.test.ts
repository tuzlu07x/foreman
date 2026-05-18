import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FOREMAN_SOUL } from "../../src/cli/identity-template.js";
import {
  applyForemanSoul,
  readForemanSoul,
} from "../../src/core/foreman-soul.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";

function entryWith(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: "test-agent",
    name: "Test Agent",
    tagline: "fixture",
    homepage: "https://example.com",
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: ">=0.0.0",
    min_foreman_version: "0.1.0",
    ...overrides,
  };
}

describe("readForemanSoul", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-soul-read-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns the shipped default when SOUL.md doesn't exist yet", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    expect(readForemanSoul(soulPath)).toBe(DEFAULT_FOREMAN_SOUL);
  });

  it("returns the user's custom content when SOUL.md is populated", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    writeFileSync(soulPath, "you are X");
    expect(readForemanSoul(soulPath)).toBe("you are X");
  });

  it("falls back to the default when SOUL.md is empty", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    writeFileSync(soulPath, "");
    expect(readForemanSoul(soulPath)).toBe(DEFAULT_FOREMAN_SOUL);
  });
});

describe("applyForemanSoul", () => {
  let tmpHome: string;
  let agentHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-soul-apply-"));
    agentHome = mkdtempSync(join(tmpdir(), "foreman-agenthome-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(agentHome, { recursive: true, force: true });
  });

  it("returns null when the registry entry has no identity_path", () => {
    const result = applyForemanSoul(
      entryWith({ identity_path: undefined }),
      join(tmpHome, "SOUL.md"),
      agentHome,
    );
    expect(result).toBeNull();
  });

  it("writes the Foreman SOUL into the agent's identity_path", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    writeFileSync(soulPath, "you are Foreman");
    const result = applyForemanSoul(
      entryWith({ identity_path: "~/agent/SOUL.md" }),
      soulPath,
      agentHome,
    );
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.path).toBe(resolve(agentHome, "agent", "SOUL.md"));
    expect(readFileSync(result!.path, "utf-8")).toBe("you are Foreman");
  });

  it("creates the parent dir when the agent home doesn't have it yet", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    writeFileSync(soulPath, "x");
    const result = applyForemanSoul(
      entryWith({ identity_path: "~/.nested/dir/SOUL.md" }),
      soulPath,
      agentHome,
    );
    expect(result).not.toBeNull();
    expect(existsSync(result!.path)).toBe(true);
  });

  it("is a no-op when the target already matches (idempotent)", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    writeFileSync(soulPath, "same content");
    const target = resolve(agentHome, "SOUL.md");
    writeFileSync(target, "same content");
    const result = applyForemanSoul(
      entryWith({ identity_path: "~/SOUL.md" }),
      soulPath,
      agentHome,
    );
    expect(result?.changed).toBe(false);
    expect(result?.path).toBe(target);
  });

  it("seeds the default when foreman SOUL.md is missing on disk", () => {
    const soulPath = join(tmpHome, "missing-SOUL.md");
    const result = applyForemanSoul(
      entryWith({ identity_path: "~/agent/SOUL.md" }),
      soulPath,
      agentHome,
    );
    expect(result?.changed).toBe(true);
    expect(readFileSync(result!.path, "utf-8")).toBe(DEFAULT_FOREMAN_SOUL);
  });
});

// #406 — The default SOUL.md template carries an "Approval Routing"
// section so any agent that calls `applyForemanSoul` (Hermes, Codex,
// future agents that declare `identity_path` in the registry) gets the
// same instruction: when the user types `/approve <id>` in chat, call
// the `submit_approval` MCP tool.
describe("DEFAULT_FOREMAN_SOUL — approval routing (#406)", () => {
  it("contains the Approval Routing section header", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("## Approval Routing");
  });

  it("documents every slash command the Telegram channel may emit", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("/approve <id>");
    expect(DEFAULT_FOREMAN_SOUL).toContain("/deny <id>");
    expect(DEFAULT_FOREMAN_SOUL).toContain("/approve_remember <id>");
    expect(DEFAULT_FOREMAN_SOUL).toContain("/deny_remember <id>");
  });

  it("references the submit_approval MCP tool by exact name", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("`submit_approval`");
  });

  it("instructs the agent to relay decisions verbatim — no chained reasoning", () => {
    expect(DEFAULT_FOREMAN_SOUL).toMatch(
      /Never.*call.*submit_approval.*on your own initiative/i,
    );
  });
});
