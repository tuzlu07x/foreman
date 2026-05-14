import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyInjection,
  detectConfigFormat,
  planInjection,
  removeForemanServer,
  UnsupportedConfigFormatError,
} from "../../src/core/agent-config-injector.js";

describe("detectConfigFormat", () => {
  it("detects yaml/yml/json/toml by extension", () => {
    expect(detectConfigFormat("/x/config.yaml")).toBe("yaml");
    expect(detectConfigFormat("/x/config.yml")).toBe("yaml");
    expect(detectConfigFormat("/x/config.json")).toBe("json");
    expect(detectConfigFormat("/x/config.toml")).toBe("toml");
  });

  it("throws for unsupported extensions", () => {
    expect(() => detectConfigFormat("/x/config.ini")).toThrow(
      UnsupportedConfigFormatError,
    );
    expect(() => detectConfigFormat("/x/config.xml")).toThrow(
      UnsupportedConfigFormatError,
    );
  });
});

describe("planInjection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-inj-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges a snippet into a missing JSON config (creates the file content)", () => {
    const path = join(tmpDir, "settings.json");
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "foreman", args: ["mcp-stdio"] } },
    });
    expect(plan.alreadyHasForeman).toBe(false);
    expect(plan.format).toBe("json");
    expect(plan.before).toBe("");
    expect(JSON.parse(plan.after)).toEqual({
      mcpServers: { foreman: { command: "foreman", args: ["mcp-stdio"] } },
    });
  });

  it("preserves existing keys when merging into a populated JSON config", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(path, JSON.stringify({ theme: "dark" }, null, 2));
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "foreman" } },
    });
    const merged = JSON.parse(plan.after);
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.foreman.command).toBe("foreman");
  });

  it("is a no-op when foreman is already in mcpServers", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { foreman: { command: "old" } } }, null, 2),
    );
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "foreman" } },
    });
    expect(plan.alreadyHasForeman).toBe(true);
    expect(plan.after).toBe(plan.before);
  });

  it("recognises foreman under the alternate mcp.servers shape", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(
      path,
      "mcp:\n  enabled: true\n  servers:\n    foreman:\n      command: foreman\n",
    );
    const plan = planInjection(path, {
      mcp: { servers: { foreman: { command: "foreman" } } },
    });
    expect(plan.alreadyHasForeman).toBe(true);
  });

  it("merges YAML configs while preserving existing top-level keys", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, "user: fatih\nverbose: true\n");
    const plan = planInjection(path, {
      mcp: { enabled: true, servers: { foreman: { command: "foreman" } } },
    });
    expect(plan.alreadyHasForeman).toBe(false);
    expect(plan.after).toContain("user: fatih");
    expect(plan.after).toContain("foreman");
  });
});

describe("applyInjection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-inj-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the planned 'after' content to disk", () => {
    const path = join(tmpDir, "nested", "settings.json");
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "foreman" } },
    });
    applyInjection(path, plan);
    const written = readFileSync(path, "utf-8");
    expect(JSON.parse(written).mcpServers.foreman.command).toBe("foreman");
  });

  it("is a no-op when the plan reports alreadyHasForeman", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { foreman: { command: "old" } } }),
    );
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "new" } },
    });
    applyInjection(path, plan);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.mcpServers.foreman.command).toBe("old");
  });
});

describe("planInjection — TOML (Codex)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-inj-toml-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a TOML config from scratch with the foreman block", () => {
    const path = join(tmpDir, "config.toml");
    const plan = planInjection(path, {
      mcp_servers: {
        foreman: {
          command: "foreman",
          args: ["mcp-stdio", "--source", "codex"],
        },
      },
    });
    expect(plan.format).toBe("toml");
    expect(plan.alreadyHasForeman).toBe(false);
    expect(plan.after).toContain("[mcp_servers.foreman]");
    expect(plan.after).toContain('command = "foreman"');
  });

  it("preserves existing TOML keys when merging", () => {
    const path = join(tmpDir, "config.toml");
    writeFileSync(
      path,
      `model = "gpt-5"\nsandbox = "docker"\n`,
      "utf-8",
    );
    const plan = planInjection(path, {
      mcp_servers: {
        foreman: {
          command: "foreman",
          args: ["mcp-stdio", "--source", "codex"],
        },
      },
    });
    expect(plan.alreadyHasForeman).toBe(false);
    expect(plan.after).toContain('model = "gpt-5"');
    expect(plan.after).toContain('sandbox = "docker"');
    expect(plan.after).toContain("[mcp_servers.foreman]");
  });

  it("is a no-op when foreman is already in [mcp_servers]", () => {
    const path = join(tmpDir, "config.toml");
    writeFileSync(
      path,
      `[mcp_servers.foreman]\ncommand = "foreman"\nargs = ["mcp-stdio"]\n`,
      "utf-8",
    );
    const plan = planInjection(path, {
      mcp_servers: { foreman: { command: "foreman", args: [] } },
    });
    expect(plan.alreadyHasForeman).toBe(true);
  });
});

describe("removeForemanServer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-inj-rm-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips foreman from mcpServers in a YAML file and preserves siblings", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(
      path,
      "mcpServers:\n  foreman:\n    command: foreman\n  other:\n    command: bar\n",
    );
    expect(removeForemanServer(path)).toBe(true);
    const after = readFileSync(path, "utf-8");
    expect(after).not.toContain("foreman");
    expect(after).toContain("other");
  });

  it("drops the mcpServers parent when foreman was the only entry (JSON)", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          theme: "dark",
          mcpServers: { foreman: { command: "foreman" } },
        },
        null,
        2,
      ),
    );
    expect(removeForemanServer(path)).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.theme).toBe("dark");
    expect(after.mcpServers).toBeUndefined();
  });

  it("strips foreman from [mcp_servers] in TOML (Codex style)", () => {
    const path = join(tmpDir, "config.toml");
    writeFileSync(
      path,
      `model = "gpt-5"\n[mcp_servers.foreman]\ncommand = "foreman"\nargs = ["mcp-stdio"]\n`,
    );
    expect(removeForemanServer(path)).toBe(true);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain('model = "gpt-5"');
    expect(after).not.toMatch(/\[mcp_servers\.foreman\]/);
  });

  it("strips foreman from the nested mcp.servers shape and tidies empty parents", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(
      path,
      "user: fatih\nmcp:\n  servers:\n    foreman:\n      command: foreman\n",
    );
    expect(removeForemanServer(path)).toBe(true);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("user: fatih");
    expect(after).not.toContain("mcp");
  });

  it("no-ops when foreman is not present (returns false, file untouched)", () => {
    const path = join(tmpDir, "settings.json");
    const original = JSON.stringify({ mcpServers: { other: {} } }, null, 2);
    writeFileSync(path, original);
    expect(removeForemanServer(path)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("no-ops when the file does not exist (returns false)", () => {
    const path = join(tmpDir, "missing.yaml");
    expect(removeForemanServer(path)).toBe(false);
  });

  it("no-ops on unsupported formats (returns false, file untouched)", () => {
    const path = join(tmpDir, "config.ini");
    writeFileSync(path, "[mcpServers]\nforeman=foreman\n");
    expect(removeForemanServer(path)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(
      "[mcpServers]\nforeman=foreman\n",
    );
  });
});
