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
  renderSoulForAgent,
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

  // QA round 12: every `{agent_id}` token in the template is rewritten
  // to the agent's registered id before the file lands on disk. Each
  // agent reads its OWN name in the identity contract instead of
  // claiming the generic Foreman identity.
  it("substitutes {agent_id} placeholder with the agent's registered id", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    writeFileSync(
      soulPath,
      "You are agent `{agent_id}` — try `foreman write {agent_id} test`.",
    );
    const result = applyForemanSoul(
      entryWith({ id: "hermes", identity_path: "~/.hermes/SOUL.md" }),
      soulPath,
      agentHome,
    );
    expect(result?.changed).toBe(true);
    const written = readFileSync(result!.path, "utf-8");
    expect(written).toBe(
      "You are agent `hermes` — try `foreman write hermes test`.",
    );
    expect(written).not.toContain("{agent_id}");
  });

  it("substitutes the SAME template differently for different agents (no cross-leak)", () => {
    const soulPath = join(tmpHome, "SOUL.md");
    writeFileSync(soulPath, "agent={agent_id}");
    const hermesResult = applyForemanSoul(
      entryWith({ id: "hermes", identity_path: "~/.hermes/SOUL.md" }),
      soulPath,
      agentHome,
    );
    const codexResult = applyForemanSoul(
      entryWith({ id: "codex", identity_path: "~/.codex/AGENTS.md" }),
      soulPath,
      agentHome,
    );
    expect(readFileSync(hermesResult!.path, "utf-8")).toBe("agent=hermes");
    expect(readFileSync(codexResult!.path, "utf-8")).toBe("agent=codex");
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
    // QA round 12: the on-disk content is the default template with
    // {agent_id} substituted (test fixture id = "test-agent"), not the
    // raw template. The substitution invariant lives in renderSoulForAgent.
    expect(readFileSync(result!.path, "utf-8")).toBe(
      renderSoulForAgent(DEFAULT_FOREMAN_SOUL, "test-agent"),
    );
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

// #431 — Orchestrator routing section. Mirrors the approval-routing
// rules but for `/foreman <verb>` commands; the agent relays them via
// the `submit_command` MCP tool.
describe("DEFAULT_FOREMAN_SOUL — orchestrator routing (#431)", () => {
  it("contains the Orchestrator Routing section header", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("## Orchestrator Routing");
  });

  it("documents the /foreman prefix the user types", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("/foreman");
    expect(DEFAULT_FOREMAN_SOUL).toContain("/foreman status");
    expect(DEFAULT_FOREMAN_SOUL).toContain("/foreman help");
  });

  it("references the submit_command MCP tool by exact name", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("`submit_command`");
  });

  it("explains the tokenization: first word = command, rest = args", () => {
    expect(DEFAULT_FOREMAN_SOUL).toMatch(/first token is the[\s\S]*command/i);
    expect(DEFAULT_FOREMAN_SOUL).toMatch(/args[\s\S]*string array/i);
  });

  it("requires verbatim relay of Foreman's response back to the user", () => {
    expect(DEFAULT_FOREMAN_SOUL).toMatch(/verbatim/i);
  });

  it("forbids unsolicited submit_command calls", () => {
    expect(DEFAULT_FOREMAN_SOUL).toMatch(
      /Never[\s\S]*call[\s\S]*submit_command[\s\S]*for messages that don't[\s\S]*prefix/i,
    );
  });

  // #451 — Hermes / OpenClaw filter unknown slash commands at the
  // parser level before the LLM sees the message. The no-slash
  // alias works around this until wrap mode (#445) lands.
  it("documents the no-slash alias as the preferred form (#451)", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("foreman status");
    expect(DEFAULT_FOREMAN_SOUL).toContain("no-slash form");
    // Equivalence table with both forms shown side by side.
    expect(DEFAULT_FOREMAN_SOUL).toMatch(/\/foreman status[\s\S]*foreman status/);
  });

  it("instructs the agent to detect both prefix forms (#451)", () => {
    expect(DEFAULT_FOREMAN_SOUL).toMatch(/\/foreman[\s\S]*or[\s\S]*foreman /i);
    expect(DEFAULT_FOREMAN_SOUL).toMatch(/case-insensitive/i);
  });
});

// QA round 12: identity contract uses `{agent_id}` placeholder so each
// agent reads its OWN registered name instead of claiming the generic
// Foreman identity. renderSoulForAgent is the pure helper covering all
// substitution sites.
describe("renderSoulForAgent (#qa-round-12)", () => {
  it("replaces a single {agent_id} occurrence", () => {
    expect(renderSoulForAgent("You are {agent_id}", "hermes")).toBe(
      "You are hermes",
    );
  });

  it("replaces every occurrence (global)", () => {
    expect(
      renderSoulForAgent(
        "{agent_id} starts here, {agent_id} ends here",
        "codex",
      ),
    ).toBe("codex starts here, codex ends here");
  });

  it("is a no-op when the template has no placeholder", () => {
    expect(renderSoulForAgent("plain text", "x")).toBe("plain text");
  });

  it("works with hyphenated agent ids (claude-code)", () => {
    expect(renderSoulForAgent("agent={agent_id}", "claude-code")).toBe(
      "agent=claude-code",
    );
  });

  it("DEFAULT_FOREMAN_SOUL uses {agent_id} (template invariant)", () => {
    expect(DEFAULT_FOREMAN_SOUL).toContain("{agent_id}");
    // After substitution the placeholder must be entirely gone — no
    // partial template strings sneaking through.
    expect(renderSoulForAgent(DEFAULT_FOREMAN_SOUL, "hermes")).not.toContain(
      "{agent_id}",
    );
  });
});
