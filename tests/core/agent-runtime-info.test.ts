import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentDefaultModel, describeBinary, updateCommandFor } from "../../src/core/agent-runtime-info.js";

// Which copy of an agent Foreman launches, and how to update that copy.
// From the 2.3.0 real test: Codex came from Homebrew's Node, `npm` on PATH
// was nvm's, and Foreman read (and would have updated) the wrong one.

describe("agent runtime info", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "foreman-runtime-info-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const npmPrefix = (name: string, version: string, withNpm = true): string => {
    const prefix = join(dir, name);
    const pkg = join(prefix, "lib", "node_modules", "@openai", "codex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version }));
    writeFileSync(join(pkg, "bin", "codex.js"), "");
    symlinkSync(join(pkg, "bin", "codex.js"), join(prefix, "bin", "codex"));
    if (withNpm) writeFileSync(join(prefix, "bin", "npm"), "");
    return prefix;
  };

  it("follows the binary to the npm install that owns it, and updates it with that install's npm", () => {
    const brewNode = npmPrefix("homebrew", "0.133.0");
    npmPrefix("nvm", "0.159.1");
    const found = describeBinary(join(brewNode, "bin", "codex"), "@openai/codex");
    expect(found.version).toBe("0.133.0");
    expect(found.owner).toEqual({ kind: "npm", prefix: expect.stringMatching(/homebrew$/), npm: join(brewNode, "bin", "npm") });
    expect(updateCommandFor(found, "@openai/codex")).toEqual([join(brewNode, "bin", "npm"), "install", "-g", "@openai/codex@latest"]);
  });

  it("falls back to npm on PATH when the install has no npm of its own", () => {
    const prefix = npmPrefix("bare", "1.0.0", false);
    const found = describeBinary(join(prefix, "bin", "codex"), "@openai/codex");
    expect(found.owner).toMatchObject({ kind: "npm", npm: null });
    expect(updateCommandFor(found, "@openai/codex")![0]).toBe("npm");
  });

  it("knows a Homebrew formula, and says nothing for a binary it can't place", () => {
    const cellar = join(dir, "Cellar", "zeroclaw", "0.4.2", "bin");
    mkdirSync(cellar, { recursive: true });
    writeFileSync(join(cellar, "zeroclaw"), "");
    mkdirSync(join(dir, "bin"));
    symlinkSync(join(cellar, "zeroclaw"), join(dir, "bin", "zeroclaw"));
    const brew = describeBinary(join(dir, "bin", "zeroclaw"), null);
    expect(brew).toMatchObject({ version: "0.4.2", owner: { kind: "brew", formula: "zeroclaw" } });
    expect(updateCommandFor(brew, null)).toEqual(["brew", "upgrade", "zeroclaw"]);
    writeFileSync(join(dir, "bin", "handmade"), "");
    const other = describeBinary(join(dir, "bin", "handmade"), "@openai/codex");
    expect(other).toMatchObject({ version: null, owner: { kind: "other" } });
    expect(updateCommandFor(other, "@openai/codex")).toBeNull();
  });

  it("reads the model each agent's own config picks, and null when it leaves it to the agent", () => {
    const codexHome = join(dir, "codex");
    const claudeDir = join(dir, "claude");
    mkdirSync(codexHome);
    mkdirSync(claudeDir);
    const env = { HOME: dir, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir };
    expect(agentDefaultModel("codex", env)).toBeNull();
    expect(agentDefaultModel("claude-code", env)).toBeNull();
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-luna"\n[mcp_servers.foreman]\ncommand = "foreman"\n');
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ model: "claude-opus-5", hooks: {} }));
    expect(agentDefaultModel("codex", env)).toBe("gpt-6-luna");
    expect(agentDefaultModel("claude-code", env)).toBe("claude-opus-5");
    writeFileSync(join(codexHome, "config.toml"), "not = [toml");
    expect(agentDefaultModel("codex", env)).toBeNull();
    expect(agentDefaultModel("hermes", env)).toBeNull();
  });
});
