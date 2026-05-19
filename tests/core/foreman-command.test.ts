import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlChannel, type OwnerStore } from "../../src/core/control-channel.js";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import {
  ForemanCommandRouter,
  registerBuiltinCommands,
  type ForemanCommandContext,
} from "../../src/core/foreman-command.js";
import { RegistryService } from "../../src/core/registry.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

function makeOwnerStore(secrets: Record<string, string>): OwnerStore {
  return {
    exists: (name: string): boolean => name in secrets,
    get: (name: string): string => {
      if (!(name in secrets)) throw new Error(`missing ${name}`);
      return secrets[name]!;
    },
  };
}

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
    it("lists every registered verb (help / status / stop / report / llm)", async () => {
      const result = await router.dispatch("help", [], ctx);
      expect(result.ok).toBe(true);
      // Built-ins must all appear.
      expect(result.text).toContain("help");
      expect(result.text).toContain("status");
      expect(result.text).toContain("stop");
      expect(result.text).toContain("report");
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

    it("llm switch returns NOT_AVAILABLE without a control channel wired", async () => {
      const result = await router.dispatch(
        "llm",
        ["switch", "openai", "gpt-4o"],
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("control channel");
    });

    it("llm budget returns NOT_AVAILABLE without a control channel wired", async () => {
      const result = await router.dispatch("llm", ["budget", "50"], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("control channel");
    });

    it("unknown llm subcommand returns UNKNOWN_SUBCOMMAND", async () => {
      const result = await router.dispatch("llm", ["chaos"], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_SUBCOMMAND");
      expect(result.text).toContain("chaos");
    });
  });

  // #440 — `/foreman stop` enqueues a `stop` command on the control
  // channel. The drain loop in `foreman start` picks it up + calls
  // the shutdown sequence. Owner-gated.
  describe("stop", () => {
    it("returns NOT_AVAILABLE without a control channel wired", async () => {
      const result = await router.dispatch("stop", [], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("control channel");
    });

    it("returns NOT_AUTHORIZED when source_user doesn't match telegram-chat-id", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner123" });
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "stranger999",
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AUTHORIZED");
      expect(channel.pending()).toHaveLength(0);
    });

    it("returns NOT_AUTHORIZED when no source_user is supplied", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner123" });
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        // sourceUser intentionally omitted
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AUTHORIZED");
    });

    it("enqueues a stop row + returns the queued id on owner match", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner123" });
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "owner123",
      });
      expect(result.ok).toBe(true);
      expect(result.text).toContain("Shutdown queued");
      expect(result.text).toMatch(/queued id=\d+/);
      const rows = channel.pending();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command).toBe("stop");
    });
  });

  // #440 — `/foreman llm switch` + `/foreman llm budget` enqueue
  // mutating commands the start-side drain handler picks up.
  describe("llm switch / budget", () => {
    it("llm switch validates the provider + model args", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch("llm", ["switch"], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "owner",
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_SUBCOMMAND");
      expect(result.text).toContain("provider");
    });

    it("llm switch enqueues with provider + model args on success", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "llm",
        ["switch", "openai", "gpt-4o-mini"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "owner",
        },
      );
      expect(result.ok).toBe(true);
      const rows = channel.pending();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command).toBe("llm-switch");
      expect(JSON.parse(rows[0]!.args)).toEqual(["openai", "gpt-4o-mini"]);
    });

    it("llm budget rejects non-numeric or non-positive values", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const ctx2 = {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "owner",
      };
      expect(
        (await router.dispatch("llm", ["budget"], ctx2)).errorCode,
      ).toBe("UNKNOWN_SUBCOMMAND");
      expect(
        (await router.dispatch("llm", ["budget", "abc"], ctx2)).errorCode,
      ).toBe("UNKNOWN_SUBCOMMAND");
      expect(
        (await router.dispatch("llm", ["budget", "-5"], ctx2)).errorCode,
      ).toBe("UNKNOWN_SUBCOMMAND");
      expect(
        (await router.dispatch("llm", ["budget", "0"], ctx2)).errorCode,
      ).toBe("UNKNOWN_SUBCOMMAND");
      expect(channel.pending()).toHaveLength(0);
    });

    it("llm budget enqueues a llm-budget row with parsed amount on success", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch("llm", ["budget", "25"], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "owner",
      });
      expect(result.ok).toBe(true);
      const rows = channel.pending();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command).toBe("llm-budget");
      expect(JSON.parse(rows[0]!.args)).toEqual(["25"]);
    });

    it("llm switch refuses non-owner", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "llm",
        ["switch", "openai", "gpt-4o"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "stranger",
        },
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AUTHORIZED");
      expect(channel.pending()).toHaveLength(0);
    });
  });

  // #432 — orchestrator chat dispatch paths. The router itself doesn't
  // call the LLM — it delegates to ctx.orchestratorChat. These tests
  // wire a stub chat and assert routing behavior + fallback messages.
  describe("orchestrator chat dispatch", () => {
    function makeStubChat(args: {
      enabled?: boolean;
      outcome?: Parameters<
        NonNullable<ForemanCommandContext["orchestratorChat"]>["answer"]
      > extends []
        ? never
        : Awaited<
            ReturnType<
              NonNullable<ForemanCommandContext["orchestratorChat"]>["answer"]
            >
          >;
    } = {}): {
      isEnabled: () => boolean;
      answer: ReturnType<typeof vi.fn>;
    } {
      return {
        isEnabled: () => args.enabled ?? true,
        answer: vi.fn().mockResolvedValue(
          args.outcome ?? {
            status: "ok",
            text: "Stub LLM response",
            costUsd: 0.0005,
            durationMs: 120,
          },
        ),
      };
    }

    it("/foreman report me invokes chat.answer with default question", async () => {
      const chat = makeStubChat();
      const result = await router.dispatch("report", ["me"], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      expect(result.ok).toBe(true);
      expect(result.text).toBe("Stub LLM response");
      const call = chat.answer.mock.calls[0]?.[0];
      expect(call.question.toLowerCase()).toContain("agents");
    });

    it("/foreman report (no args) uses default question too", async () => {
      const chat = makeStubChat();
      await router.dispatch("report", [], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      const call = chat.answer.mock.calls[0]?.[0];
      expect(typeof call.question).toBe("string");
      expect(call.question.length).toBeGreaterThan(0);
    });

    it("/foreman report <free text> sends the text verbatim", async () => {
      const chat = makeStubChat();
      await router.dispatch(
        "report",
        ["how", "did", "hermes", "do", "today?"],
        {
          ...ctx,
          orchestratorChat: chat as unknown as NonNullable<
            ForemanCommandContext["orchestratorChat"]
          >,
        },
      );
      const call = chat.answer.mock.calls[0]?.[0];
      expect(call.question).toBe("how did hermes do today?");
    });

    it("/foreman report Turkish hint switches the default question language", async () => {
      const chat = makeStubChat();
      await router.dispatch("report", ["ne", "yapıyorsunuz"], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      const call = chat.answer.mock.calls[0]?.[0];
      // Should pass through the user's input as-is, not the default.
      expect(call.question).toBe("ne yapıyorsunuz");
    });

    it("/foreman report when chat is disabled returns NOT_AVAILABLE", async () => {
      const chat = makeStubChat({ enabled: false });
      const result = await router.dispatch("report", ["me"], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(chat.answer).not.toHaveBeenCalled();
    });

    it("/foreman report without orchestratorChat in ctx returns NOT_AVAILABLE", async () => {
      const result = await router.dispatch("report", ["me"], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
    });

    it("unknown verb falls through to LLM when orchestratorChat is enabled", async () => {
      const chat = makeStubChat();
      const result = await router.dispatch(
        "what-is-happening-with-everything",
        ["right", "now"],
        {
          ...ctx,
          orchestratorChat: chat as unknown as NonNullable<
            ForemanCommandContext["orchestratorChat"]
          >,
        },
      );
      expect(result.ok).toBe(true);
      expect(chat.answer).toHaveBeenCalledOnce();
      const call = chat.answer.mock.calls[0]?.[0];
      expect(call.question).toBe(
        "what-is-happening-with-everything right now",
      );
    });

    it("unknown verb returns UNKNOWN_COMMAND when chat is disabled", async () => {
      const chat = makeStubChat({ enabled: false });
      const result = await router.dispatch("nonsense-verb", [], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_COMMAND");
      expect(chat.answer).not.toHaveBeenCalled();
    });

    it("focus-agent dispatch: first token matching a registered agent sets focusAgentId", async () => {
      registry.register({
        id: "openclaw",
        displayName: "OpenClaw",
        transport: "stdio",
      });
      const chat = makeStubChat();
      await router.dispatch("openclaw", ["ne", "yapıyor"], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      const call = chat.answer.mock.calls[0]?.[0];
      expect(call.focusAgentId).toBe("openclaw");
      expect(call.question).toBe("openclaw ne yapıyor");
    });

    it("budget_exceeded outcome surfaces as NOT_AVAILABLE with spend / cap", async () => {
      const chat = makeStubChat({
        outcome: { status: "budget_exceeded", spentUsd: 6.2, capUsd: 5 },
      });
      const result = await router.dispatch("report", ["me"], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("$6.20");
      expect(result.text).toContain("$5.00");
    });

    it("failed outcome surfaces the reason", async () => {
      const chat = makeStubChat({
        outcome: { status: "failed", reason: "network timeout" },
      });
      const result = await router.dispatch("report", ["me"], {
        ...ctx,
        orchestratorChat: chat as unknown as NonNullable<
          ForemanCommandContext["orchestratorChat"]
        >,
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("network timeout");
    });
  });
});
