import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentNotInRegistryError,
  findAgent,
  getRegistryCachePath,
  getUpstreamRegistryUrl,
  loadActiveRegistry,
  loadBundledRegistry,
  parseRegistryText,
  REGISTRY_CACHE_TTL_MS,
  RegistryValidationError,
  writeRegistryCache,
  type RegistryDoc,
} from "../../src/core/registry-catalog.js";

function freshAgent(): Record<string, unknown> {
  return {
    id: "hermes",
    name: "Hermes",
    tagline: "Personal assistant",
    homepage: "https://example.com/",
    install: { npm: "hermes-agent", brew: null },
    config_paths: ["~/.hermes/config.yaml"],
    config_snippet: "registry/snippets/hermes.yaml",
    required_secrets: ["anthropic-key"],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: ">=2.0.0",
    min_foreman_version: "0.1.2",
  };
}

function validDoc(): Record<string, unknown> {
  return { version: 1, agents: [freshAgent()] };
}

describe("parseRegistryText", () => {
  it("accepts a well-formed document and returns the typed shape", () => {
    const doc = parseRegistryText(JSON.stringify(validDoc()));
    expect(doc.agents).toHaveLength(1);
    expect(doc.agents[0]?.id).toBe("hermes");
  });

  it("rejects invalid JSON with RegistryValidationError", () => {
    expect(() => parseRegistryText("{ not json")).toThrow(
      RegistryValidationError,
    );
  });

  it("rejects an unknown agent field (strict mode)", () => {
    const agent = freshAgent();
    agent.extra_field = true;
    const doc = { version: 1, agents: [agent] };
    try {
      parseRegistryText(JSON.stringify(doc));
      throw new Error("expected validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryValidationError);
      const e = err as RegistryValidationError;
      expect(e.issues.some((i) => i.path.includes("agents"))).toBe(true);
    }
  });

  it("rejects an agent id that is not kebab-case", () => {
    const agent = freshAgent();
    agent.id = "Hermes_Bad";
    const doc = { version: 1, agents: [agent] };
    expect(() => parseRegistryText(JSON.stringify(doc))).toThrow(
      RegistryValidationError,
    );
  });

  it("rejects a non-uri homepage", () => {
    const agent = freshAgent();
    agent.homepage = "not-a-url";
    const doc = { version: 1, agents: [agent] };
    expect(() => parseRegistryText(JSON.stringify(doc))).toThrow(
      RegistryValidationError,
    );
  });

  it("rejects a tagline over 80 characters", () => {
    const agent = freshAgent();
    agent.tagline = "x".repeat(81);
    const doc = { version: 1, agents: [agent] };
    expect(() => parseRegistryText(JSON.stringify(doc))).toThrow(
      RegistryValidationError,
    );
  });

  it("rejects an unknown registry version", () => {
    const doc = { version: 99, agents: [] };
    expect(() => parseRegistryText(JSON.stringify(doc))).toThrow(
      RegistryValidationError,
    );
  });

  // PR B of the multi-agent orchestration epic — task_command_template
  // is the new optional field that declares how Foreman spawns the
  // agent non-interactively when `foreman write <agent> <task>` is
  // called against it. Generic for any agent with a `--print` /
  // `exec` / `--prompt` style CLI mode.
  describe("task_command_template + task_timeout_seconds (PR B)", () => {
    it("accepts a well-formed task_command_template string", () => {
      const agent = freshAgent();
      agent.task_command_template = "codex exec \"${task}\"";
      const doc = { version: 1, agents: [agent] };
      const parsed = parseRegistryText(JSON.stringify(doc));
      expect(parsed.agents[0]?.task_command_template).toBe(
        "codex exec \"${task}\"",
      );
    });

    it("treats task_command_template as optional (defaults to undefined)", () => {
      const agent = freshAgent();
      // intentionally not set
      const doc = { version: 1, agents: [agent] };
      const parsed = parseRegistryText(JSON.stringify(doc));
      expect(parsed.agents[0]?.task_command_template).toBeUndefined();
    });

    it("rejects an empty-string task_command_template", () => {
      const agent = freshAgent();
      agent.task_command_template = "";
      const doc = { version: 1, agents: [agent] };
      expect(() => parseRegistryText(JSON.stringify(doc))).toThrow(
        RegistryValidationError,
      );
    });

    it("accepts a positive integer task_timeout_seconds", () => {
      const agent = freshAgent();
      agent.task_command_template = "x ${task}";
      agent.task_timeout_seconds = 600;
      const doc = { version: 1, agents: [agent] };
      const parsed = parseRegistryText(JSON.stringify(doc));
      expect(parsed.agents[0]?.task_timeout_seconds).toBe(600);
    });

    it("rejects zero or negative task_timeout_seconds", () => {
      for (const bad of [0, -5, -1]) {
        const agent = freshAgent();
        agent.task_command_template = "x ${task}";
        agent.task_timeout_seconds = bad;
        const doc = { version: 1, agents: [agent] };
        expect(() => parseRegistryText(JSON.stringify(doc))).toThrow(
          RegistryValidationError,
        );
      }
    });

    it("rejects non-integer task_timeout_seconds (floats not allowed)", () => {
      const agent = freshAgent();
      agent.task_command_template = "x ${task}";
      agent.task_timeout_seconds = 1.5;
      const doc = { version: 1, agents: [agent] };
      expect(() => parseRegistryText(JSON.stringify(doc))).toThrow(
        RegistryValidationError,
      );
    });
  });
});

describe("loadBundledRegistry", () => {
  it("loads the repo's own registry/agents.json and finds 5 agents", () => {
    const doc = loadBundledRegistry();
    expect(doc.version).toBe(1);
    expect(doc.agents.length).toBeGreaterThanOrEqual(5);
    const ids = doc.agents.map((a) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "hermes",
        "openclaw",
        "claude-code",
        "zeroclaw",
        "generic-mcp",
      ]),
    );
  });

  // PR B — Verify the bundled registry declares task_command_template
  // for callable agents (Codex, Claude Code). Hermes is a daemon, so
  // it doesn't get one; OpenClaw / ZeroClaw / generic-mcp don't have
  // verified non-interactive CLI modes yet — they fall back to the
  // existing queue + relay behavior in foreman write.
  it("declares task_command_template for Codex (non-interactive exec mode)", () => {
    const doc = loadBundledRegistry();
    const codex = doc.agents.find((a) => a.id === "codex");
    expect(codex?.task_command_template).toBe("codex exec \"${task}\"");
    expect(codex?.task_timeout_seconds).toBe(600);
  });

  it("declares task_command_template for Claude Code (--print mode)", () => {
    const doc = loadBundledRegistry();
    const claude = doc.agents.find((a) => a.id === "claude-code");
    expect(claude?.task_command_template).toBe(
      "claude --print \"${task}\"",
    );
    expect(claude?.task_timeout_seconds).toBe(600);
  });

  it("does NOT declare task_command_template for daemon-style agents (Hermes)", () => {
    const doc = loadBundledRegistry();
    const hermes = doc.agents.find((a) => a.id === "hermes");
    expect(hermes?.task_command_template).toBeUndefined();
  });
});

describe("loadActiveRegistry + cache TTL", () => {
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-reg-"));
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmpHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("falls back to the bundled registry when no cache exists", () => {
    const { source } = loadActiveRegistry();
    expect(source).toBe("bundled");
  });

  it("uses the cache when within TTL", () => {
    const agent = freshAgent();
    agent.id = "custom-cached";
    writeRegistryCache(
      { version: 1, agents: [agent] } as unknown as RegistryDoc,
      Date.now(),
    );
    const { doc, source } = loadActiveRegistry();
    expect(source).toBe("cache");
    expect(doc.agents[0]?.id).toBe("custom-cached");
  });

  it("falls back to bundled when the cache is stale", () => {
    const stale = Date.now() - REGISTRY_CACHE_TTL_MS - 1000;
    writeRegistryCache(validDoc() as unknown as RegistryDoc, stale);
    const { source } = loadActiveRegistry();
    expect(source).toBe("bundled");
  });

  it("falls back to bundled when the cache file is corrupted", () => {
    const cachePath = getRegistryCachePath();
    mkdirSync(join(tmpHome, "cache"), { recursive: true });
    writeFileSync(cachePath, "{ malformed", "utf-8");
    const { source } = loadActiveRegistry();
    expect(source).toBe("bundled");
  });
});

describe("findAgent", () => {
  it("returns the matching entry", () => {
    const entry = findAgent(loadBundledRegistry(), "hermes");
    expect(entry.id).toBe("hermes");
  });

  it("throws AgentNotInRegistryError when not found", () => {
    expect(() => findAgent(loadBundledRegistry(), "ghost-agent")).toThrow(
      AgentNotInRegistryError,
    );
  });
});

describe("getUpstreamRegistryUrl", () => {
  const original = process.env.FOREMAN_REGISTRY_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.FOREMAN_REGISTRY_URL;
    else process.env.FOREMAN_REGISTRY_URL = original;
  });

  it("returns the default GitHub raw URL when no env override is set", () => {
    delete process.env.FOREMAN_REGISTRY_URL;
    expect(getUpstreamRegistryUrl()).toContain("raw.githubusercontent.com");
  });

  it("honours the FOREMAN_REGISTRY_URL env override", () => {
    process.env.FOREMAN_REGISTRY_URL = "https://example.test/r.json";
    expect(getUpstreamRegistryUrl()).toBe("https://example.test/r.json");
  });
});
