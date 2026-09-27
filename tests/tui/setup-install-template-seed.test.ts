import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Seeding an agent's config from its bundled template (OpenClaw) creates
// the file exclusively: a file or symlink that appears at the path after
// the existence check is never overwritten or written through. (The MCP
// snippet merge that runs afterwards has its own symlink handling, #618;
// this test only pins the seed.) No real installer runs, HOME is a temp dir.

vi.mock("../../src/core/agent-install.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/agent-install.js")>();
  return {
    ...actual,
    detectInstall: vi.fn(() => ({ found: true, path: "/usr/bin/openclaw" })),
    runInstall: vi.fn(async () => ({ ok: true, exitCode: 0 })),
    runUninstall: vi.fn(async () => ({ ok: true, exitCode: 0 })),
    runShell: vi.fn(async () => ({ ok: true, exitCode: 0 })),
    runPostConfigCommands: vi.fn(async () => []),
  };
});

const { runInstallStep } = await import("../../src/tui/setup-wizard.js");
const { EventBus } = await import("../../src/core/event-bus.js");
const { RegistryService } = await import("../../src/core/registry.js");
const { SecretStore } = await import("../../src/core/secret-store.js");
const { createInMemoryDb } = await import("../../src/db/client.js");

describe("config template seeding", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof createInMemoryDb>["db"];
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "foreman-template-seed-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(() => {
    sqlite.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("never writes through a symlink planted at the config path", async () => {
    const target = join(home, "elsewhere.json");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const configPath = join(home, ".openclaw", "openclaw.json");
    // Dangling: existsSync() says "missing", so the seed path is taken.
    symlinkSync(target, configPath);

    const logs: string[] = [];
    await runInstallStep(
      ["openclaw"],
      [],
      {
        db,
        secretStore: new SecretStore(db, Buffer.alloc(32, 7)),
        registry: new RegistryService(db, new EventBus()),
        policyPath: join(home, "policy.yaml"),
        llmConfigPath: join(home, "llm.yaml"),
        notifyConfigPath: join(home, "notify.yaml"),
        voiceConfigPath: join(home, "voice.yaml"),
        launchEditor: vi.fn().mockResolvedValue(undefined) as () => Promise<unknown>,
      },
      (line) => logs.push(line),
    );

    expect(logs.join("\n")).not.toContain("seeded OpenClaw config");
    // The template's own keys never reached the symlink's target.
    const written = existsSync(target) ? readFileSync(target, "utf-8") : "";
    expect(written).not.toContain('"gateway"');
    expect(written).not.toContain('"workspace"');
  });
});
