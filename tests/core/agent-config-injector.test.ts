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
  it("detects yaml/yml/json by extension", () => {
    expect(detectConfigFormat("/x/config.yaml")).toBe("yaml");
    expect(detectConfigFormat("/x/config.yml")).toBe("yaml");
    expect(detectConfigFormat("/x/config.json")).toBe("json");
  });

  it("throws for unsupported extensions", () => {
    expect(() => detectConfigFormat("/x/config.toml")).toThrow(
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
