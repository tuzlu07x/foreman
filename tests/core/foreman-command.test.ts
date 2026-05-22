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
    it("lists every registered verb (help / status / stop / write / report / activity / llm)", async () => {
      const result = await router.dispatch("help", [], ctx);
      expect(result.ok).toBe(true);
      // Built-ins must all appear.
      expect(result.text).toContain("help");
      expect(result.text).toContain("status");
      expect(result.text).toContain("stop");
      expect(result.text).toContain("write");
      expect(result.text).toContain("report");
      expect(result.text).toContain("activity");
      expect(result.text).toContain("model");
      expect(result.text).toContain("llm");
    });

    // QA round 15 — `/foreman agent` and `/foreman agents` are common
    // misfires when an agent's LLM is asked "what's installed".
    // Aliased to `status` so the call doesn't bounce off
    // unknown-command.
    it("`/foreman agent` and `/foreman agents` are aliases of `status`", async () => {
      const agentRes = await router.dispatch("agent", [], ctx);
      const agentsRes = await router.dispatch("agents", [], ctx);
      const statusRes = await router.dispatch("status", [], ctx);
      expect(agentRes.ok).toBe(true);
      expect(agentsRes.ok).toBe(true);
      expect(statusRes.ok).toBe(true);
      // The body shape should match. We don't compare strings exactly
      // (the version banner could pick up trivial whitespace diffs);
      // matching the lead line is enough.
      const head = (text: string) => text.split("\n")[0];
      expect(head(agentRes.text)).toBe(head(statusRes.text));
      expect(head(agentsRes.text)).toBe(head(statusRes.text));
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
      // QA round 17: Telegram user_ids are always numeric. Test now
      // uses numeric ids on both sides to model the real scenario
      // (different legit Telegram users) rather than placeholder text.
      const store = makeOwnerStore({ "telegram-chat-id": "111000111" });
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "999000999",
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AUTHORIZED");
      // QA round 10: error text distinguishes the two failure modes —
      // here source_user IS sent but the wrong value. Echoing the
      // received id helps the user spot whether their telegram-chat-id
      // is the one they expect.
      expect(result.text).toContain("999000999");
      expect(result.text).toContain("doesn't match");
      expect(channel.pending()).toHaveLength(0);
    });

    it("falls back to telegram-chat-id when source_user is absent (QA round 13)", async () => {
      // The agent's LLM intermittently forgets to pass source_user on
      // the MCP call. Rather than reject the legit owner on those
      // turns, Foreman now falls back to the configured
      // telegram-chat-id. Safe for 1:1 chats (only the owner DMs the
      // bot anyway). Group chats are not yet supported in v0.1.
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner123" });
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        // sourceUser intentionally omitted — fallback should kick in
      });
      expect(result.ok).toBe(true);
      expect(channel.pending()).toHaveLength(1);
      // The enqueued row carries the resolved owner id so the drain
      // handler sees a consistent value.
      expect(channel.pending()[0]?.sourceUser).toBe("owner123");
    });

    it("falls back identically when source_user is empty string (QA round 13)", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner123" });
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "",
      });
      expect(result.ok).toBe(true);
      expect(channel.pending()).toHaveLength(1);
    });

    // QA round 17: Hermes' LLM sometimes passes the user's DISPLAY
    // NAME (e.g. "Isa") instead of the numeric Telegram user id.
    // Pre-QA17 the fallback only fired on empty source_user, so "Isa"
    // != "12345" → NOT_AUTHORIZED → owner locked out. Telegram user
    // ids are always digits — non-numeric source_user is by definition
    // wrong, so treat it the same as missing and fall back.
    it("falls back when source_user is non-numeric (LLM passed display name) — QA round 17", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "8263464163" });
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "Isa", // ← display name, not user id
      });
      expect(result.ok).toBe(true);
      expect(channel.pending()).toHaveLength(1);
      // Audit row should record the *resolved* numeric id so the
      // drain handler sees a consistent owner.
      expect(channel.pending()[0]?.sourceUser).toBe("8263464163");
    });

    it("rejects when source_user is absent AND no telegram-chat-id is configured", async () => {
      // No fallback available → user gets a clear "configure
      // telegram-chat-id" hint, not the old "agent forgot" message.
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({}); // empty — no telegram-chat-id
      const result = await router.dispatch("stop", [], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AUTHORIZED");
      expect(result.text).toMatch(/didn't pass it/);
      expect(result.text).toMatch(/secrets add telegram-chat-id/);
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
      // Wording softened from "queued id" → "tracking id" so the suffix
      // reads as an audit reference, not a "still waiting" status.
      expect(result.text).toMatch(/tracking id=\d+/);
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
      // QA17: use numeric ids on both sides (real Telegram format) so
      // the non-numeric-fallback added for the display-name case
      // doesn't mask the legitimate cross-user rejection.
      const store = makeOwnerStore({ "telegram-chat-id": "111000111" });
      const result = await router.dispatch(
        "llm",
        ["switch", "openai", "gpt-4o"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "999000999",
        },
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AUTHORIZED");
      expect(channel.pending()).toHaveLength(0);
    });
  });

  // #433 — `/foreman write <agent> <message>` enqueues a write
  // directive. Owner-gated like other mutating verbs. Validates the
  // agent is registered before enqueueing.
  describe("write", () => {
    beforeEach(() => {
      registry.register({
        id: "openclaw",
        displayName: "OpenClaw",
        transport: "stdio",
      });
      // QA round 10 tests use hermes + codex; register both so the
      // registry lookup passes and the self-target / cross-agent
      // logic gets exercised instead of the unknown-agent branch.
      registry.register({
        id: "hermes",
        displayName: "Hermes",
        transport: "stdio",
      });
      registry.register({
        id: "codex",
        displayName: "Codex",
        transport: "stdio",
      });
    });

    it("requires both agent + message args", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const ctxOk = {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "owner",
      };
      expect((await router.dispatch("write", [], ctxOk)).errorCode).toBe(
        "UNKNOWN_SUBCOMMAND",
      );
      expect(
        (await router.dispatch("write", ["openclaw"], ctxOk)).errorCode,
      ).toBe("UNKNOWN_SUBCOMMAND");
      expect(channel.pending()).toHaveLength(0);
    });

    it("rejects an unknown agent id (before owner check or enqueue)", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "write",
        ["ghost-agent", "hello"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "owner",
        },
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_SUBCOMMAND");
      expect(result.text).toContain("ghost-agent");
      expect(channel.pending()).toHaveLength(0);
    });

    it("refuses non-owner senders", async () => {
      const channel = new ControlChannel(db);
      // QA17: numeric ids on both sides (real Telegram format).
      const store = makeOwnerStore({ "telegram-chat-id": "111000111" });
      const result = await router.dispatch(
        "write",
        ["openclaw", "msg"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "999000999",
        },
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AUTHORIZED");
      expect(channel.pending()).toHaveLength(0);
    });

    it("enqueues with [agentId, joined message] args on success", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "write",
        ["openclaw", "pause", "task", "Y"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "owner",
        },
      );
      expect(result.ok).toBe(true);
      expect(result.text).toContain("openclaw");
      const rows = channel.pending();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command).toBe("write");
      expect(JSON.parse(rows[0]!.args)).toEqual(["openclaw", "pause task Y"]);
    });

    it("lower-cases the agent id token (case-insensitive lookup)", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "write",
        ["OpenClaw", "hi"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "owner",
        },
      );
      expect(result.ok).toBe(true);
      const rows = channel.pending();
      expect(JSON.parse(rows[0]!.args)).toEqual(["openclaw", "hi"]);
    });

    // QA round 10: `foreman write hermes hello` typed in the Hermes
    // chat used to enqueue a directive Hermes itself would never
    // pick up (it's the agent typing AND the target). Users assumed
    // Foreman was broken — actually a usage error. Catch it explicitly.
    it("self-target — refuses + suggests typing directly to this agent", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "write",
        ["hermes", "hello"],
        {
          ...ctx,
          sourceAgent: "hermes",
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "owner",
        },
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_SUBCOMMAND");
      expect(result.text).toContain("already talking");
      expect(result.text).toContain("hermes");
      expect(channel.pending()).toHaveLength(0);
    });

    it("self-target is case-insensitive (HERMES from sourceAgent=hermes)", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "write",
        ["HERMES", "hi"],
        {
          ...ctx,
          sourceAgent: "hermes",
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "owner",
        },
      );
      expect(result.ok).toBe(false);
      expect(channel.pending()).toHaveLength(0);
    });

    it("cross-agent to callable target enqueues + says 'spawning ... output will arrive'", async () => {
      // PR D: codex declares task_command_template in the bundled
      // registry, so foreman write now SPAWNS rather than queues+
      // relays. Success text reflects the new contract — the user
      // should wait for the follow-up output post, not forward
      // anything.
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "owner" });
      const result = await router.dispatch(
        "write",
        ["codex", "review the PR"],
        {
          ...ctx,
          sourceAgent: "hermes",
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "owner",
        },
      );
      expect(result.ok).toBe(true);
      expect(result.text).toMatch(/Spawning codex/);
      expect(result.text).toMatch(/output will arrive/);
      // QA round 14: the "(tracking id=N)" / "(queued id=N)" suffix is
      // dropped for spawn — the message already explains what happens,
      // and a trailing "queued" reads like the task is stuck.
      expect(result.text).not.toMatch(/queued id=|tracking id=/);
      expect(channel.pending()).toHaveLength(1);
    });
  });

  // QA round 14 — `/foreman activity` is a non-LLM view of recent
  // control_commands rows. Previously returned "Unknown command".
  describe("activity", () => {
    it("returns NOT_AVAILABLE when no control channel is wired", async () => {
      const result = await router.dispatch("activity", [], ctx);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("NOT_AVAILABLE");
      expect(result.text).toContain("control channel");
    });

    it("returns an empty-state hint when there are no rows yet", async () => {
      const channel = new ControlChannel(db);
      const result = await router.dispatch("activity", [], {
        ...ctx,
        controlChannel: channel,
      });
      expect(result.ok).toBe(true);
      expect(result.text).toMatch(/No \/foreman directives/);
    });

    it("lists recent rows newest-first with status glyph + id", async () => {
      const channel = new ControlChannel(db);
      channel.enqueue({
        command: "write",
        args: ["codex", "review the PR"],
        sourceAgent: "hermes",
      });
      const second = channel.enqueue({
        command: "stop",
        args: [],
        sourceAgent: "hermes",
      });
      channel.markApplied(second.id);
      const result = await router.dispatch("activity", [], {
        ...ctx,
        controlChannel: channel,
      });
      expect(result.ok).toBe(true);
      expect(result.text).toContain("stop");
      expect(result.text).toContain("write codex: review the PR");
      // Newest first → "stop" line appears before "write" line.
      const stopIdx = result.text.indexOf("stop");
      const writeIdx = result.text.indexOf("write codex");
      expect(stopIdx).toBeLessThan(writeIdx);
      // Applied row uses ✓, pending uses … — both must appear.
      expect(result.text).toContain("✓");
      expect(result.text).toContain("…");
    });

    it("clamps an out-of-range limit arg to the default", async () => {
      const channel = new ControlChannel(db);
      for (let i = 0; i < 3; i++) {
        channel.enqueue({
          command: "write",
          args: ["codex", `task ${i}`],
          sourceAgent: "hermes",
        });
      }
      const result = await router.dispatch("activity", ["9999"], {
        ...ctx,
        controlChannel: channel,
      });
      expect(result.ok).toBe(true);
      // 9999 is out of range → clamped to default 10. All 3 rows shown.
      expect(result.text).toContain("task 0");
      expect(result.text).toContain("task 2");
    });
  });

  // #502 — `/foreman model` chat command. Three modes:
  //   0 args → status list
  //   1 arg  → Foreman LLM model (provider-preserving)
  //   2 args, first = provider → Foreman LLM provider+model
  //   2 args, first = agent id → per-agent override (agents.model_version)
  describe("model", () => {
    beforeEach(() => {
      registry.register({
        id: "codex",
        displayName: "Codex",
        transport: "stdio",
      });
      registry.register({
        id: "claude-code",
        displayName: "Claude Code",
        transport: "stdio",
      });
    });

    it("0 args: shows Foreman LLM + per-agent models", async () => {
      const result = await router.dispatch("model", [], ctx);
      expect(result.ok).toBe(true);
      // Header for Foreman LLM
      expect(result.text).toMatch(/Foreman LLM/);
      // Both agents appear
      expect(result.text).toContain("codex");
      expect(result.text).toContain("claude-code");
      // Usage hints (no-slash form is what Telegram users type)
      expect(result.text).toContain("foreman model");
    });

    it("0 args: includes tap-to-copy quick-switch commands per provider", async () => {
      const result = await router.dispatch("model", [], ctx);
      expect(result.ok).toBe(true);
      // Foreman LLM curated list (default config = anthropic)
      expect(result.text).toContain("`foreman model claude-haiku-4-5`");
      expect(result.text).toContain("`foreman model claude-sonnet-4-6`");
      // Per-agent quick switches:
      // codex → openai models
      expect(result.text).toContain("`foreman model codex gpt-5-mini`");
      expect(result.text).toContain("`foreman model codex gpt-5`");
      // claude-code → anthropic models
      expect(result.text).toContain("`foreman model claude-code claude-sonnet-4-6`");
      // "Clear override" rows
      expect(result.text).toContain("`foreman model codex clear`");
      expect(result.text).toContain("`foreman model claude-code clear`");
      // Cost hints
      expect(result.text).toMatch(/cheapest/);
      expect(result.text).toMatch(/balanced/);
      expect(result.text).toMatch(/top tier/);
    });

    it("`models` is an alias of `model`", async () => {
      const a = await router.dispatch("model", [], ctx);
      const b = await router.dispatch("models", [], ctx);
      expect(a.text.split("\n")[0]).toBe(b.text.split("\n")[0]);
    });

    it("1 arg: enqueues llm-switch keeping current provider", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "888777666" });
      const result = await router.dispatch("model", ["gpt-5-mini"], {
        ...ctx,
        controlChannel: channel,
        ownerStore: store,
        sourceUser: "888777666",
      });
      expect(result.ok).toBe(true);
      const rows = channel.pending();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.command).toBe("llm-switch");
      const args = JSON.parse(rows[0]!.args) as string[];
      // Provider auto-resolved from current llm.yaml (default 'anthropic'),
      // model is the user's pick.
      expect(args).toEqual(["anthropic", "gpt-5-mini"]);
    });

    it("2 args, provider first: explicit Foreman LLM switch", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "888777666" });
      const result = await router.dispatch(
        "model",
        ["openai", "gpt-5-mini"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "888777666",
        },
      );
      expect(result.ok).toBe(true);
      const rows = channel.pending();
      expect(rows[0]?.command).toBe("llm-switch");
      expect(JSON.parse(rows[0]!.args)).toEqual(["openai", "gpt-5-mini"]);
    });

    it("2 args, agent id first: per-agent override enqueued", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "888777666" });
      const result = await router.dispatch(
        "model",
        ["codex", "gpt-5-mini"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "888777666",
        },
      );
      expect(result.ok).toBe(true);
      const rows = channel.pending();
      expect(rows[0]?.command).toBe("agent-model");
      expect(JSON.parse(rows[0]!.args)).toEqual(["codex", "gpt-5-mini"]);
    });

    it("unknown agent id (not a provider either) → UNKNOWN_SUBCOMMAND with hint", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "888777666" });
      const result = await router.dispatch(
        "model",
        ["ghost-agent", "gpt-5-mini"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "888777666",
        },
      );
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("UNKNOWN_SUBCOMMAND");
      expect(result.text).toContain("ghost-agent");
      // The hint should list available agent ids.
      expect(result.text).toContain("codex");
      expect(channel.pending()).toHaveLength(0);
    });

    it("clear keyword removes the agent override (empty string in row)", async () => {
      const channel = new ControlChannel(db);
      const store = makeOwnerStore({ "telegram-chat-id": "888777666" });
      const result = await router.dispatch(
        "model",
        ["codex", "clear"],
        {
          ...ctx,
          controlChannel: channel,
          ownerStore: store,
          sourceUser: "888777666",
        },
      );
      expect(result.ok).toBe(true);
      const rows = channel.pending();
      expect(rows[0]?.command).toBe("agent-model");
      // Drain handler reads "" and calls setModelVersion(agentId, null).
      expect(JSON.parse(rows[0]!.args)).toEqual(["codex", ""]);
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
