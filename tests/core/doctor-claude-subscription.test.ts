import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { checkClaudeSubscriptionKey } from "../../src/core/doctor.js";
import { bus } from "../../src/core/event-bus.js";
import { RegistryService } from "../../src/core/registry.js";
import { closeDb, getDb } from "../../src/db/client.js";

// An ANTHROPIC_API_KEY in Claude Code's settings.json `env` wins over the
// subscription sign-in: a claude-code role on the subscription route then
// failed with "401 API key is invalid" (a revoked key, real-services test
// 2.3.0). Doctor names it, without showing the key.

const KEY = "sk-ant-api03-revoked-test-value";

describe("doctor: claude_subscription", () => {
  let tmp: string;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-doctor-claude-sub-"));
    home = join(tmp, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = join(tmp, "foreman");
    runInit();
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  const register = (providerVariant: string): void => {
    new RegistryService(getDb(), bus).register({
      id: "claude-code",
      displayName: "Claude Code",
      transport: "stdio",
      llmProvider: "anthropic",
      providerVariant,
    });
  };
  const settings = (dir: string, body: unknown): string => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it("warns when the subscription route meets env.ANTHROPIC_API_KEY in settings.json, never showing the key", () => {
    register("oauth");
    const path = settings(join(home, ".claude"), { env: { ANTHROPIC_API_KEY: KEY, OTHER: "x" }, model: "opus" });
    const before = readFileSync(path, "utf-8");
    const r = checkClaudeSubscriptionKey({}, home);
    expect(r.status).toBe("warn");
    expect(r.message).toBe(`Claude Code uses the API key from ${path} instead of your Claude subscription`);
    expect(r.remediation).toBe(`Remove env.ANTHROPIC_API_KEY from ${path} to use the subscription.`);
    expect(JSON.stringify(r)).not.toContain(KEY);
    // Read-only.
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("reads $CLAUDE_CONFIG_DIR/settings.json when that is set", () => {
    register("oauth");
    settings(join(home, ".claude"), {});
    const custom = settings(join(tmp, "claude-config"), { env: { ANTHROPIC_API_KEY: KEY } });
    const r = checkClaudeSubscriptionKey({ CLAUDE_CONFIG_DIR: join(tmp, "claude-config") }, home);
    expect(r.status).toBe("warn");
    expect(r.message).toContain(custom);
  });

  it("stays ok without a key, with an empty one, or on unreadable settings", () => {
    register("oauth");
    expect(checkClaudeSubscriptionKey({}, home)).toMatchObject({ status: "ok" });
    settings(join(home, ".claude"), { env: { ANTHROPIC_API_KEY: "  ", OTHER: "x" } });
    expect(checkClaudeSubscriptionKey({}, home)).toMatchObject({ status: "ok" });
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    expect(checkClaudeSubscriptionKey({}, home)).toMatchObject({ status: "ok" });
  });

  it("says nothing about a key when claude-code is on the API-key route (the key is the route)", () => {
    register("direct");
    settings(join(home, ".claude"), { env: { ANTHROPIC_API_KEY: KEY } });
    const r = checkClaudeSubscriptionKey({}, home);
    expect(r.status).toBe("ok");
    expect(r.message).toContain("isn't on the Claude subscription route");
  });

  it("skips when claude-code isn't registered", () => {
    settings(join(home, ".claude"), { env: { ANTHROPIC_API_KEY: KEY } });
    expect(checkClaudeSubscriptionKey({}, home)).toMatchObject({ status: "ok" });
  });
});
