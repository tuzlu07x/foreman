import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #618 — the wizard writes an agent's config (template seed, MCP wiring
// with the agent's identity token, projected keys) only through writers
// that refuse a symlink at the path: a dangling symlink planted at
// ~/.openclaw/openclaw.json must not get a file created at its target,
// nor be replaced. No real installer runs; HOME is a temp dir.

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

describe("wizard config writes and symlinks (#618)", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof createInMemoryDb>["db"];
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "foreman-wiring-symlink-home-"));
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

  const install = async (): Promise<string[]> => {
    const logs: string[] = [];
    const secretStore = new SecretStore(db, Buffer.alloc(32, 7));
    secretStore.add("openai-key", "sk-test-not-a-real-key-000000");
    await runInstallStep(
      ["openclaw"],
      [],
      {
        db,
        secretStore,
        registry: new RegistryService(db, new EventBus()),
        policyPath: join(home, "policy.yaml"),
        llmConfigPath: join(home, "llm.yaml"),
        notifyConfigPath: join(home, "notify.yaml"),
        voiceConfigPath: join(home, "voice.yaml"),
        launchEditor: vi.fn().mockResolvedValue(undefined) as () => Promise<unknown>,
      },
      (line) => logs.push(line),
      { openclaw: { llmProvider: "openai" } },
      undefined,
      { providersSelected: ["openai"], servicesSelected: [] },
    );
    return logs;
  };

  it("refuses the wiring at a dangling symlink, says why, and writes nothing through it", async () => {
    const target = join(home, "elsewhere.json");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const configPath = join(home, ".openclaw", "openclaw.json");
    symlinkSync(target, configPath);

    const logs = (await install()).join("\n");

    expect(existsSync(target)).toBe(false);
    // The symlink is left as it was, not replaced by a regular file.
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(target);
    expect(logs).toContain(
      `config inject skipped: ${configPath} is a symlink; Foreman won't write an agent token through one`,
    );
    expect(logs).toContain("keys not projected either");
    expect(logs).not.toContain("wrote MCP snippet");
    expect(logs).not.toContain("seeded OpenClaw config");
  });

  it("leaves a symlink to an existing file, and that file, untouched", async () => {
    const target = join(home, "dotfiles-openclaw.json");
    writeFileSync(target, '{ "gateway": { "mode": "local" } }\n', { mode: 0o644 });
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const configPath = join(home, ".openclaw", "openclaw.json");
    symlinkSync(target, configPath);

    const logs = (await install()).join("\n");

    expect(readFileSync(target, "utf-8")).toBe('{ "gateway": { "mode": "local" } }\n');
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(logs).toContain(`${configPath} is a symlink`);
  });

  it("still seeds and wires a regular config, owner-only", async () => {
    const logs = (await install()).join("\n");
    const configPath = join(home, ".openclaw", "openclaw.json");
    expect(logs).toContain("seeded OpenClaw config");
    expect(logs).toContain(`wrote MCP snippet to ${configPath}`);
    expect(lstatSync(configPath).isFile()).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf-8")).toMatch(/"FOREMAN_AGENT_TOKEN": "fat_/);
    // Wired for it: no by-hand token hint.
    expect(logs).not.toContain("--token-out");
  });
});
