import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import {
  ForemanCommandRouter,
  registerBuiltinCommands,
  type ForemanCommandContext,
} from "../../src/core/foreman-command.js";
import { writeForemanPidfile } from "../../src/core/foreman-pidfile.js";
import { RegistryService } from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("ForemanCommandRouter (#431)", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let registry: RegistryService;
  let tmp: string;
  let llmConfigPath: string;
  let router: ForemanCommandRouter;
  let ctx: ForemanCommandContext;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    tmp = mkdtempSync(join(tmpdir(), "foreman-cmd-"));
    llmConfigPath = join(tmp, "llm.yaml");
    router = new ForemanCommandRouter();
    registerBuiltinCommands(router);
    ctx = {
      db,
      registry,
      llmConfigPath,
      configDir: tmp,
      sourceAgent: "hermes",
    };
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("dispatch", () => {
    it("routes case-insensitively", async () => {
      const lower = await router.dispatch("help", [], ctx);
      const upper = await router.dispatch("HELP", [], ctx);
      const mixed = await router.dispatch("Help", [], ctx);
      expect(lower.ok).toBe(true);
      expect(upper.ok).toBe(true);
      expect(mixed.ok).toBe(true);
      expect(lower.text).toBe(upper.text);
      expect(lower.text).toBe(mixed.text);
    });

    it("returns UNKNOWN_COMMAND for verbs that aren't registered", async () => {
      const result = await router.dispatch("supernova", [], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_COMMAND");
      expect(result.text).toContain("Unknown command");
      expect(result.text).toContain("supernova");
      expect(result.text).toContain("/foreman help");
    });

    it("custom handlers can be registered + dispatched", async () => {
      router.register(
        "echo",
        (args) => ({ ok: true, text: `echo: ${args.join(" ")}` }),
        "Reflect args back.",
      );
      const result = await router.dispatch("echo", ["hello", "world"], ctx);
      expect(result.ok).toBe(true);
      expect(result.text).toBe("echo: hello world");
    });
  });

  describe("help", () => {
    it("lists every registered verb (help / status / stop / llm)", async () => {
      const result = await router.dispatch("help", [], ctx);
      expect(result.ok).toBe(true);
      // Built-ins must all appear.
      expect(result.text).toContain("help");
      expect(result.text).toContain("status");
      expect(result.text).toContain("stop");
      expect(result.text).toContain("llm");
    });

    it("includes custom-registered verbs after registration", async () => {
      router.register(
        "custom-thing",
        () => ({ ok: true, text: "" }),
        "Reflects.",
      );
      const result = await router.dispatch("help", [], ctx);
      expect(result.text).toContain("custom-thing");
    });
  });

  describe("status", () => {
    it("reports zero agents on a fresh DB", async () => {
      const result = await router.dispatch("status", [], ctx);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("0 agent");
    });

    it("counts agents broken down by status", async () => {
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
      registry.register({
        id: "openclaw",
        displayName: "OpenClaw",
        transport: "stdio",
      });
      registry.block("openclaw");
      const result = await router.dispatch("status", [], ctx);
      expect(result.text).toContain("2 agent");
      expect(result.text).toContain("1 active");
      expect(result.text).toContain("1 blocked");
      expect(result.text).toContain("hermes");
      expect(result.text).toContain("openclaw");
    });
  });

  describe("llm", () => {
    it("default-routes to llm status when no subcommand given", async () => {
      const result = await router.dispatch("llm", [], ctx);
      expect(result.ok).toBe(true);
      // When no llm.yaml exists, defaultLlmConfig() is enabled=false
      // until the user sets it up — verify the "disabled" branch fires.
      expect(result.text.toLowerCase()).toContain("disabled");
    });

    it("explicit `llm status` matches the default route", async () => {
      const implicit = await router.dispatch("llm", [], ctx);
      const explicit = await router.dispatch("llm", ["status"], ctx);
      expect(explicit.text).toBe(implicit.text);
    });

    it("reports provider + model + budget when enabled", async () => {
      writeFileSync(
        llmConfigPath,
        [
          "enabled: true",
          "provider: openai",
          "model: gpt-4o-mini",
          "budget:",
          "  monthly_cap_usd: 20",
          "  alert_threshold_pct: 80",
          "  reset_day_of_month: 1",
          "features:",
          "  verification: true",
          "  smart_report: true",
          "  policy_suggestions: true",
          "",
        ].join("\n"),
      );
      const result = await router.dispatch("llm", [], ctx);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("openai");
      expect(result.text).toContain("gpt-4o-mini");
      expect(result.text).toContain("Budget");
      expect(result.text).toContain("$0.00");
      expect(result.text).toContain("$20.00");
    });

    it("llm switch returns NOT_AVAILABLE pointing at the CLI", async () => {
      const result = await router.dispatch(
        "llm",
        ["switch", "openai", "gpt-4o"],
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("foreman llm switch");
    });

    it("llm budget returns NOT_AVAILABLE pointing at the CLI", async () => {
      const result = await router.dispatch("llm", ["budget", "50"], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("foreman llm budget");
    });

    it("unknown llm subcommand returns UNKNOWN_SUBCOMMAND", async () => {
      const result = await router.dispatch("llm", ["chaos"], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_SUBCOMMAND");
      expect(result.text).toContain("chaos");
    });
  });

  // #431 — `/foreman stop` sends SIGTERM to the PID recorded in
  // `<configDir>/foreman.pid`. The handler is process-bridging: it
  // runs in `mcp-stdio` but signals `foreman start`.
  describe("stop", () => {
    it("returns NOT_AVAILABLE when no pidfile exists", async () => {
      const result = await router.dispatch("stop", [], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text.toLowerCase()).toContain("isn't running");
    });

    it("returns NOT_AVAILABLE when pidfile points at a dead process", async () => {
      // PID 1 belongs to init/systemd in real environments but we
      // can't kill it; the pidfile-stale check uses kill(pid, 0)
      // which will succeed there. Use a definitely-gone PID instead:
      // 2^31 - 1, way out of normal ranges.
      writeForemanPidfile(ctx.configDir);
      // Overwrite with a bogus PID. writeForemanPidfile uses
      // process.pid by default, so re-create the file directly.
      writeFileSync(join(ctx.configDir, "foreman.pid"), "2147483647", "utf-8");
      const result = await router.dispatch("stop", [], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
    });

    it("sends SIGTERM to the PID and reports success", async () => {
      writeForemanPidfile(ctx.configDir);
      // Mock process.kill so the test doesn't actually kill itself.
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(() => true);
      try {
        const result = await router.dispatch("stop", [], ctx);
        expect(result.ok).toBe(true);
        expect(result.text).toContain("Shutting down");
        expect(result.text).toContain(String(process.pid));
        // First call is the alive-check (kill(pid, 0)); second is SIGTERM.
        const sigtermCall = killSpy.mock.calls.find(
          (c) => c[1] === "SIGTERM",
        );
        expect(sigtermCall).toBeDefined();
        expect(sigtermCall?.[0]).toBe(process.pid);
      } finally {
        killSpy.mockRestore();
      }
    });
  });
});
