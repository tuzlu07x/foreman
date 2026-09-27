import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #646 — On a Node outside OpenClaw's engines range, neither the setup
// wizard nor `foreman agent add` may run `npm install -g openclaw`. They
// explain the requirement and print the upstream installer as text. No
// real installer runs in this file: the install transport is mocked and
// the Node version is pinned. HOME points at a temp dir because the
// in-range case goes on to seed OpenClaw's config under ~/.openclaw.

vi.mock("../../src/core/node-engines.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/node-engines.js")>();
  return {
    ...actual,
    resolveInstallerNodeVersion: vi.fn(() => ({
      version: "22.12.0",
      source: "PATH" as const,
    })),
  };
});

vi.mock("../../src/core/agent-install.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/agent-install.js")>();
  const fail = { ok: false, exitCode: 1, manualCommand: "(mocked)" };
  return {
    ...actual,
    detectInstall: vi.fn(() => ({ found: false })),
    runInstall: vi.fn(async () => fail),
    runUninstall: vi.fn(async () => fail),
    runShell: vi.fn(async () => fail),
    runPostConfigCommands: vi.fn(async () => []),
  };
});

const { runInstallStep } = await import("../../src/tui/setup-wizard.js");
const { runAgentAddScripted } = await import("../../src/cli/agent-add.js");
const { runInstall } = await import("../../src/core/agent-install.js");
const { resolveInstallerNodeVersion } = await import(
  "../../src/core/node-engines.js"
);
const { EventBus } = await import("../../src/core/event-bus.js");
const { RegistryService } = await import("../../src/core/registry.js");
const { SecretStore } = await import("../../src/core/secret-store.js");
const { createInMemoryDb } = await import("../../src/db/client.js");

const UPSTREAM = "curl -fsSL https://openclaw.ai/install.sh | bash";
const RANGE = ">=24.16.0 <25 || >=26.1.0";

describe("OpenClaw install on a Node below its engines range", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof createInMemoryDb>["db"];
  let registry: InstanceType<typeof RegistryService>;
  let logs: string[];
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "foreman-node-engines-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    registry = new RegistryService(db, new EventBus());
    logs = [];
    vi.mocked(runInstall).mockClear();
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function wizardServices() {
    return {
      db,
      secretStore: new SecretStore(db, Buffer.alloc(32, 7)),
      registry,
      policyPath: "/tmp/policy.yaml",
      llmConfigPath: "/tmp/llm.yaml",
      notifyConfigPath: "/tmp/notify.yaml",
      voiceConfigPath: "/tmp/voice.yaml",
      launchEditor: vi.fn().mockResolvedValue(undefined) as () => Promise<unknown>,
    };
  }

  it("wizard: skips OpenClaw with the requirement, installs the rest", async () => {
    const summary = await runInstallStep(
      ["openclaw", "generic-mcp"],
      [],
      wizardServices(),
      (line) => logs.push(line),
    );

    expect(runInstall).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("npm install -g openclaw"))).toBe(false);
    const text = logs.join("\n");
    expect(text).toContain(`OpenClaw needs Node ${RANGE}`);
    expect(text).toContain("v22.12.0");
    expect(text).toContain(UPSTREAM);

    // OpenClaw isn't registered; the other agent in the batch still is.
    expect(registry.get("openclaw")).toBeNull();
    expect(summary.registered).toEqual(["generic-mcp"]);
    expect(summary.failed).toEqual(["openclaw"]);
    expect(summary.nodeEngineSkipped.map((s) => s.agentId)).toEqual([
      "openclaw",
    ]);
    expect(summary.nodeEngineSkipped[0]!.lines.join("\n")).toContain(UPSTREAM);
  });

  it("wizard: every explanation line stays visible in the collapsed log", async () => {
    await runInstallStep(["openclaw"], [], wizardServices(), (line) =>
      logs.push(line),
    );
    const start = logs.findIndex((l) => l.includes("needs Node"));
    const explanation = logs.slice(start, start + 3);
    for (const line of explanation) {
      expect(line.trimStart()).toMatch(/^[⚠◦]/);
    }
  });

  it("wizard: installs normally when Node is in range", async () => {
    vi.mocked(resolveInstallerNodeVersion).mockReturnValueOnce({
      version: "24.16.0",
      source: "PATH",
    });
    await runInstallStep(["openclaw"], [], wizardServices(), (line) =>
      logs.push(line),
    );
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("npm install -g openclaw"))).toBe(true);
    // Anything the flow wrote landed in the temp HOME.
    expect(logs.join("\n")).toContain(home);
  });

  it("agent add --auto-install: explains and exits 1 without installing or registering", async () => {
    const errors: string[] = [];
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((msg: unknown) => {
        errors.push(String(msg));
      });
    const code = await runAgentAddScripted(
      "openclaw",
      { type: "openclaw", autoInstall: true },
      { db, registry, log: (line) => logs.push(line) },
    );
    errSpy.mockRestore();

    expect(code).toBe(1);
    expect(runInstall).not.toHaveBeenCalled();
    expect(registry.get("openclaw")).toBeNull();
    expect(errors.join("\n")).toContain(`OpenClaw needs Node ${RANGE}`);
    expect(logs.join("\n")).toContain(UPSTREAM);
  });

  it("agent add without --auto-install: prints the requirement, not the npm command", async () => {
    const code = await runAgentAddScripted(
      "openclaw",
      { type: "openclaw", skipConfig: true, skipProjection: true },
      { db, registry, log: (line) => logs.push(line) },
    );

    expect(code).toBe(0);
    expect(runInstall).not.toHaveBeenCalled();
    const text = logs.join("\n");
    expect(text).toContain(`OpenClaw needs Node ${RANGE}`);
    expect(text).toContain(UPSTREAM);
    expect(text).not.toContain("npm install -g openclaw");
  });
});
