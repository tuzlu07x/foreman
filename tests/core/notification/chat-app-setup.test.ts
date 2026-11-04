import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chatAppReady,
  explainDeliveryError,
  findTelegramChat,
  removeChatApp,
  restartHint,
  saveChatApp,
  TWO_WAY_GUIDE,
} from "../../../src/core/notification/chat-app-setup.js";
import { loadNotifyConfig, routeFor, saveNotifyConfig, defaultNotifyConfig } from "../../../src/core/notification/notify-config.js";
import { checkDiscordBot, checkSlackBot, discordInviteUrl } from "../../../src/core/notification/token-checks.js";
import { SecretStore } from "../../../src/core/secret-store.js";
import { createInMemoryDb } from "../../../src/db/client.js";

// The Services page stored a token, said "configured" and stopped: the channel
// was never turned on, so nothing was sent. These cover the whole job.

describe("the two-way Slack guide", () => {
  it("names the command, the reinstall and what Slack says without them", () => {
    const guide = TWO_WAY_GUIDE.slack.join("\n");
    expect(guide).toContain("Create New Command → /foreman");
    expect(guide).toContain("Install App → Reinstall");
    expect(guide).toContain("is not a valid command");
  });
});

describe("saving a chat app", () => {
  let dir: string;
  let path: string;
  let store: SecretStore;
  let close: () => void;
  const deps = (): { store: SecretStore; notifyConfigPath: string } => ({ store, notifyConfigPath: path });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-chat-app-"));
    path = join(dir, "notify.yaml");
    const h = createInMemoryDb();
    store = new SecretStore(h.db, Buffer.alloc(32, 7));
    close = () => h.sqlite.close();
  });
  afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Telegram: stores the token, turns the channel on with your chat", () => {
    const toggle = saveChatApp("telegram", { token: "123:abc", chatId: "42" }, deps());
    expect(store.get("telegram-bot-token")).toBe("123:abc");
    expect(toggle).toMatchObject({ enabled: true, bot_token_ref: "telegram-bot-token", chat_id: "42" });
    expect(loadNotifyConfig(path).channels.telegram?.chat_id).toBe("42");
    expect(chatAppReady("telegram", toggle, (n) => store.exists(n))).toBe(true);
  });

  it("Slack and Discord get approvals: the default routing only names Telegram", () => {
    saveChatApp("slack", { token: "xoxb-1", target: "#foreman" }, deps());
    saveChatApp("discord", { token: "d", target: "123456" }, deps());
    const config = loadNotifyConfig(path);
    expect(routeFor(config, "critical")?.channels).toEqual(expect.arrayContaining(["telegram", "slack", "discord"]));
    expect(routeFor(config, "warning")?.channels).toContain("slack");
  });

  it("keeps a route you chose yourself", () => {
    const config = defaultNotifyConfig();
    config.routing.summary = { ...config.routing.summary!, channels: ["slack"] };
    saveNotifyConfig(path, config);
    saveChatApp("slack", { token: "xoxb-1", target: "#foreman" }, deps());
    expect(routeFor(loadNotifyConfig(path), "critical")?.channels).toEqual(["telegram"]);
  });

  it("two-way Slack needs the app token and who may decide, and keeps earlier users", () => {
    saveChatApp("slack", { token: "xoxb-1", target: "#foreman", appToken: "xapp-1", userId: "U1" }, deps());
    const toggle = saveChatApp("slack", { userId: "U2" }, deps());
    expect(store.get("slack-app-token")).toBe("xapp-1");
    expect(toggle.app_token_ref).toBe("slack-app-token");
    expect(toggle.allowed_user_ids).toEqual(["U2", "U1"]);
  });

  it("Slack without a user id stays push-only, whatever token was typed", () => {
    expect(saveChatApp("slack", { token: "xoxb-1", target: "#foreman" }, deps()).app_token_ref).toBeUndefined();
  });

  it("two-way Discord turns on with a user id", () => {
    const toggle = saveChatApp("discord", { token: "d", target: "123456", userId: "999999" }, deps());
    expect(toggle).toMatchObject({ interactive: true, allowed_user_ids: ["999999"], channel: "123456" });
  });

  it("removing one stops it for good: no missing-secret warning on the next start", () => {
    saveChatApp("telegram", { token: "123:abc", chatId: "42" }, deps());
    removeChatApp("telegram", deps());
    expect(store.exists("telegram-bot-token")).toBe(false);
    expect(loadNotifyConfig(path).channels.telegram?.enabled).toBe(false);
  });

  it("a token alone isn't ready: there is nowhere to send", () => {
    const hasToken = (): boolean => true;
    expect(chatAppReady("telegram", null, hasToken)).toBe(false);
    expect(chatAppReady("telegram", { enabled: true, bot_token_ref: "t" }, hasToken)).toBe(false);
    expect(chatAppReady("slack", { enabled: true, bot_token_ref: "t" }, hasToken)).toBe(false);
    expect(chatAppReady("slack", { enabled: true, webhook_url_ref: "u" }, hasToken)).toBe(true);
    expect(chatAppReady("slack", { enabled: true, bot_token_ref: "t", channel: "#a" }, () => false)).toBe(false);
  });
});

describe("finding your Telegram chat", () => {
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body));
  const update = (chat: Record<string, unknown>) => ({ message: { chat } });

  it("finds the private chat that wrote last", async () => {
    const found = await findTelegramChat(
      "t",
      answer({ ok: true, result: [update({ id: 1, type: "private", first_name: "Old" }), update({ id: 2, type: "private", first_name: "Ada" })] }),
    );
    expect(found).toEqual({ status: "ok", value: { chatId: "2", name: "Ada" } });
  });

  it("ignores groups: approvals belong in your own chat", async () => {
    const found = await findTelegramChat("t", answer({ ok: true, result: [update({ id: -100, type: "supergroup", title: "Team" })] }));
    expect(found).toEqual({ status: "ok", value: null });
  });

  it("says when the token is refused and when Telegram can't be reached", async () => {
    expect(await findTelegramChat("t", answer({ ok: false, description: "Unauthorized" }))).toEqual({ status: "rejected", detail: "Unauthorized" });
    const down = async (): Promise<Response> => {
      throw new Error("fetch failed");
    };
    expect((await findTelegramChat("t", down)).status).toBe("unreachable");
  });
});

describe("checking bot tokens", () => {
  it("Slack names the bot", async () => {
    const ok = await checkSlackBot("t", async () => new Response(JSON.stringify({ ok: true, user: "foreman" })));
    expect(ok).toEqual({ status: "ok", value: { username: "foreman" } });
    const no = await checkSlackBot("t", async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" })));
    expect(no).toEqual({ status: "rejected", detail: "invalid_auth" });
  });

  it("Discord names the bot, which gives its invite link", async () => {
    const ok = await checkDiscordBot("t", async () => new Response(JSON.stringify({ id: "42", username: "foreman" })));
    expect(ok).toEqual({ status: "ok", value: { id: "42", username: "foreman" } });
    expect(discordInviteUrl("42")).toContain("client_id=42&scope=bot+applications.commands&permissions=19456");
  });
});

describe("explaining a failed delivery", () => {
  it.each([
    ["telegram", 'sendMessage HTTP 401: {"ok":false,"description":"Unauthorized"}', /rejected the bot token.*@BotFather/],
    ["telegram", "sendMessage HTTP 400: Bad Request: chat not found", /press Start/],
    ["slack", "slack delivery failed (HTTP 200): invalid_auth", /xoxb-/],
    ["slack", "slack delivery failed (HTTP 200): not_in_channel", /\/invite @your-bot/],
    ["slack", "slack delivery failed (HTTP 200): channel_not_found", /can't find that channel/],
    ["discord", 'discord delivery failed (HTTP 401): {"message": "401: Unauthorized"}', /Reset Token/],
    ["discord", 'discord delivery failed (HTTP 403): {"message": "Missing Access", "code": 50001}', /can't see that channel/],
    ["discord", 'discord delivery failed (HTTP 404): {"message": "Unknown Channel", "code": 10003}', /Copy Channel ID/],
    ["telegram", "fetch failed", /Couldn't reach Telegram/],
  ] as const)("%s: %s", (id, raw, expected) => {
    expect(explainDeliveryError(id, raw)).toMatch(expected);
  });

  it("anything else keeps the original words", () => {
    expect(explainDeliveryError("slack", "something new")).toBe("Slack didn't take the message: something new");
  });

  it("says how to restart for each way Foreman runs", () => {
    expect(restartHint(true)).toContain("foreman service install");
    expect(restartHint(false)).toContain("foreman start");
  });
});
