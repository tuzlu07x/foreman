import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyInjection,
  detectConfigFormat,
  planInjection,
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

  it("is a no-op when foreman is already canonical in mcpServers", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { foreman: { command: "foreman" } } }, null, 2),
    );
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "foreman" } },
    });
    expect(plan.alreadyHasForeman).toBe(true);
    expect(plan.replacedStale).toBe(false);
    expect(plan.after).toBe(plan.before);
  });

  it("replaces a stale foreman entry in mcpServers and preserves siblings (#215)", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          mcpServers: {
            foreman: { command: "/old/path/to/foreman", args: ["legacy"] },
            other: { command: "other-bin" },
          },
          userKey: "user-value",
        },
        null,
        2,
      ),
    );
    const plan = planInjection(path, {
      mcpServers: {
        foreman: { command: "foreman", args: ["mcp-stdio", "--source", "cc"] },
      },
    });
    expect(plan.alreadyHasForeman).toBe(false);
    expect(plan.replacedStale).toBe(true);
    const after = JSON.parse(plan.after);
    expect(after.mcpServers.foreman).toEqual({
      command: "foreman",
      args: ["mcp-stdio", "--source", "cc"],
    });
    expect(after.mcpServers.other).toEqual({ command: "other-bin" });
    expect(after.userKey).toBe("user-value");
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

  it("is a no-op when the plan reports alreadyHasForeman (canonical match)", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { foreman: { command: "foreman" } } }),
    );
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "foreman" } },
    });
    applyInjection(path, plan);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.mcpServers.foreman.command).toBe("foreman");
  });

  it("writes the replacement when the plan reports replacedStale (#215)", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { foreman: { command: "old" } } }),
    );
    const plan = planInjection(path, {
      mcpServers: { foreman: { command: "new" } },
    });
    expect(plan.replacedStale).toBe(true);
    applyInjection(path, plan);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.mcpServers.foreman.command).toBe("new");
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

  it("is a no-op when [mcp_servers.foreman] is canonical", () => {
    const path = join(tmpDir, "config.toml");
    writeFileSync(
      path,
      `[mcp_servers.foreman]\ncommand = "foreman"\nargs = ["mcp-stdio"]\n`,
      "utf-8",
    );
    const plan = planInjection(path, {
      mcp_servers: { foreman: { command: "foreman", args: ["mcp-stdio"] } },
    });
    expect(plan.alreadyHasForeman).toBe(true);
    expect(plan.replacedStale).toBe(false);
  });

  it("replaces stale [mcp_servers.foreman] while preserving sibling tables (#215)", () => {
    const path = join(tmpDir, "config.toml");
    writeFileSync(
      path,
      `model = "gpt-5"\n[mcp_servers.foreman]\ncommand = "/old/foreman"\nargs = ["legacy"]\n[mcp_servers.other]\ncommand = "other"\n`,
      "utf-8",
    );
    const plan = planInjection(path, {
      mcp_servers: { foreman: { command: "foreman", args: ["mcp-stdio"] } },
    });
    expect(plan.replacedStale).toBe(true);
    expect(plan.after).toContain('model = "gpt-5"');
    expect(plan.after).toContain('command = "foreman"');
    expect(plan.after).not.toContain('"/old/foreman"');
    expect(plan.after).toContain("mcp_servers.other");
  });
});
