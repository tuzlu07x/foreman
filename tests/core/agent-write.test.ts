import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverWriteDirective } from "../../src/core/agent-write.js";

function makeFetchOk(messageId = 4242): typeof fetch {
  return vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        ok: true,
        result: { message_id: messageId, chat: { id: 1 } },
      }),
    } as unknown as Response;
  });
}

function makeFetchFail(status: number, body: string): typeof fetch {
  return vi.fn(async () => {
    return {
      ok: false,
      status,
      text: async () => body,
      json: async () => ({ ok: false, description: body }),
    } as unknown as Response;
  });
}

describe("deliverWriteDirective (#433)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-write-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("Telegram leg", () => {
    it("sends a formatted directive when bot token + chat id are present", async () => {
      const fetchImpl = makeFetchOk(123);
      const outcome = await deliverWriteDirective(
        { agentId: "openclaw", message: "switch to task Y" },
        {
          telegramBotToken: "tg-token-test",
          telegramChatId: "chat-42",
          fetchImpl,
        },
      );
      expect(outcome.status).toBe("delivered");
      if (outcome.status === "delivered") {
        expect(outcome.via).toContain("telegram");
        expect(outcome.messageId).toBe("123");
      }
      expect(fetchImpl).toHaveBeenCalledOnce();
      const callArgs = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(callArgs[0]).toContain("api.telegram.org/bottg-token-test/sendMessage");
      const init = callArgs[1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe("chat-42");
      expect(body.text).toContain("Foreman");
      expect(body.text).toContain("openclaw");
      expect(body.text).toContain("switch to task Y");
      expect(body.parse_mode).toBe("MarkdownV2");
    });

    it("escapes Markdown specials in agent + message", async () => {
      const fetchImpl = makeFetchOk();
      await deliverWriteDirective(
        { agentId: "claude-code", message: "do *step 1* then [step 2]" },
        {
          telegramBotToken: "tk",
          telegramChatId: "1",
          fetchImpl,
        },
      );
      const body = JSON.parse(
        ((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
          .body as string,
      );
      // `*`, `[`, `]`, `-` must be escaped per MarkdownV2.
      expect(body.text).toContain("claude\\-code");
      expect(body.text).toContain("\\*step 1\\*");
      expect(body.text).toContain("\\[step 2\\]");
    });

    it("skips Telegram leg when bot token is absent + returns failed if file write also skipped", async () => {
      const outcome = await deliverWriteDirective(
        { agentId: "openclaw", message: "x" },
        { telegramChatId: "42" },
      );
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.error).toMatch(/telegram-bot-token/i);
      }
    });

    it("skips Telegram leg when chat id is absent + returns failed if file write also skipped", async () => {
      const outcome = await deliverWriteDirective(
        { agentId: "openclaw", message: "x" },
        { telegramBotToken: "tk" },
      );
      expect(outcome.status).toBe("failed");
    });

    it("surfaces an HTTP failure as failed outcome (no file write fallback)", async () => {
      const fetchImpl = makeFetchFail(401, "unauthorized");
      const outcome = await deliverWriteDirective(
        { agentId: "openclaw", message: "x" },
        {
          telegramBotToken: "wrong-token",
          telegramChatId: "1",
          fetchImpl,
        },
      );
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.error).toContain("401");
      }
    });

    it("surfaces a Telegram-level !ok response as failed", async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ ok: false, description: "bot blocked by user" }),
      })) as unknown as typeof fetch;
      const outcome = await deliverWriteDirective(
        { agentId: "openclaw", message: "x" },
        {
          telegramBotToken: "tk",
          telegramChatId: "1",
          fetchImpl,
        },
      );
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.error).toContain("bot blocked by user");
      }
    });
  });

  describe("inbound_dir leg", () => {
    it("writes a ulid-named file when the agent declares inbound_dir", async () => {
      const fetchImpl = makeFetchOk();
      const inboundDir = join(tmp, "openclaw-inbound");
      const outcome = await deliverWriteDirective(
        {
          agentId: "openclaw",
          message: "do X",
          sourceUser: "owner-123",
          inboundDir,
        },
        {
          telegramBotToken: "tk",
          telegramChatId: "1",
          fetchImpl,
          homeDir: tmp,
        },
      );
      expect(outcome.status).toBe("delivered");
      if (outcome.status === "delivered") {
        expect(outcome.via).toContain("telegram");
        expect(outcome.via).toContain("file");
      }
      const files = readdirSync(inboundDir);
      expect(files).toHaveLength(1);
      const content = readFileSync(join(inboundDir, files[0]!), "utf-8");
      expect(content).toContain("# Foreman directive");
      expect(content).toContain("agent: openclaw");
      expect(content).toContain("from_user: owner-123");
      expect(content).toContain("do X");
    });

    it("expands ~ in inbound_dir against the supplied home", async () => {
      const fetchImpl = makeFetchOk();
      const outcome = await deliverWriteDirective(
        {
          agentId: "openclaw",
          message: "x",
          inboundDir: "~/.openclaw/inbound",
        },
        {
          telegramBotToken: "tk",
          telegramChatId: "1",
          fetchImpl,
          homeDir: tmp,
        },
      );
      expect(outcome.status).toBe("delivered");
      expect(existsSync(join(tmp, ".openclaw/inbound"))).toBe(true);
    });

    it("works file-only when no telegram creds are configured", async () => {
      const inboundDir = join(tmp, "wrap-only");
      const outcome = await deliverWriteDirective(
        {
          agentId: "wrap-only-agent",
          message: "boot the queue",
          inboundDir,
        },
        { homeDir: tmp },
      );
      // Telegram skipped → warning recorded → partial since file wrote.
      expect(outcome.status).toBe("partial");
      if (outcome.status === "partial") {
        expect(outcome.via).toEqual(["file"]);
        expect(outcome.warnings.join(" ")).toMatch(/telegram/i);
      }
    });

    it("records a warning + falls back to telegram-only when file write fails", async () => {
      const fetchImpl = makeFetchOk();
      // Use an unwritable path to force a write failure.
      const outcome = await deliverWriteDirective(
        {
          agentId: "openclaw",
          message: "x",
          inboundDir: "/this/path/should/not/be/writable/foreman-test",
        },
        {
          telegramBotToken: "tk",
          telegramChatId: "1",
          fetchImpl,
          homeDir: tmp,
        },
      );
      expect(outcome.status).toBe("partial");
      if (outcome.status === "partial") {
        expect(outcome.via).toEqual(["telegram"]);
        expect(outcome.warnings.join(" ")).toMatch(/file write/i);
      }
    });
  });
});
