import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadNotifyConfig } from "../../src/core/notification/notify-config.js";
import type { ServiceEntry } from "../../src/core/registry-catalog.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb } from "../../src/db/client.js";
import { ChatAppConnect, type ChatAppApi } from "../../src/tui/pages/chat-app-connect.js";

const ENTER = "\r";
const strip = (s: string | undefined): string => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

const service = (id: string): ServiceEntry =>
  ({ id, name: id, secret_name: `${id}-bot-token`, where_to_get: null, format_hint: "token", setup_steps: ["Make a bot"], used_by_agents: [] }) as unknown as ServiceEntry;

describe("setting up a chat app on the Services page", () => {
  let dir: string;
  let path: string;
  let store: SecretStore;
  let close: () => void;
  let api: ChatAppApi;
  let done: string[];
  let tested: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-connect-"));
    path = join(dir, "notify.yaml");
    const h = createInMemoryDb();
    store = new SecretStore(h.db, Buffer.alloc(32, 7));
    close = () => h.sqlite.close();
    done = [];
    tested = [];
    api = {
      checkToken: async () => ({ status: "ok", value: { username: "acme_bot", id: "42" } }),
      checkSlackAppToken: async () => ({ status: "ok", value: null }),
      findTelegramChat: async () => ({ status: "ok", value: { chatId: "7", name: "Ada" } }),
      test: async (id) => {
        tested.push(id);
        return { ok: true };
      },
    };
  });
  afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (id: "telegram" | "slack" | "discord", currentTarget?: string) =>
    render(
      React.createElement(ChatAppConnect, {
        id,
        service: service(id),
        store,
        notifyConfigPath: path,
        api,
        attached: false,
        currentTarget,
        onDone: (m: string) => done.push(m),
      }),
    );
  const type = async (app: ReturnType<typeof open>, text: string): Promise<void> => {
    await tick();
    if (text) app.stdin.write(text);
    await tick();
    app.stdin.write(ENTER);
    await tick(150);
  };

  it("Telegram: token, your chat found and confirmed, test sent", async () => {
    const app = open("telegram");
    await type(app, "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(strip(app.lastFrame())).toContain("@acme_bot");
    await type(app, "");
    expect(strip(app.lastFrame())).toContain("Found Ada (chat 7)");
    app.stdin.write("y");
    await tick(150);
    expect(tested).toEqual(["telegram"]);
    expect(done[0]).toMatch(/^✓ Telegram is connected.*press q, then foreman start/);
    expect(loadNotifyConfig(path).channels.telegram).toMatchObject({ enabled: true, chat_id: "7" });
  });

  it("nobody's chat is used until you say it is yours", async () => {
    const app = open("telegram");
    await type(app, "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    await type(app, "");
    app.stdin.write("n");
    await tick(100);
    expect(done).toEqual([]);
    expect(strip(app.lastFrame())).toContain("type your own chat id");
    await type(app, "555");
    expect(loadNotifyConfig(path).channels.telegram?.chat_id).toBe("555");
  });

  it("says when the bot has no message yet, and tries again", async () => {
    let answers = 0;
    api.findTelegramChat = async () => (++answers === 1 ? { status: "ok", value: null } : { status: "ok", value: { chatId: "7", name: "Ada" } });
    const app = open("telegram");
    await type(app, "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    await type(app, "");
    expect(strip(app.lastFrame())).toContain("No message yet");
    await type(app, "");
    expect(strip(app.lastFrame())).toContain("Found Ada");
  });

  it("a rejected token stays on the token step and saves nothing", async () => {
    api.checkToken = async () => ({ status: "rejected", detail: "Unauthorized" });
    const app = open("telegram");
    await type(app, "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(strip(app.lastFrame())).toContain("Telegram rejected that token");
    expect(store.exists("telegram-bot-token")).toBe(false);
  });

  it("holds a value that doesn't look like a token until you insist", async () => {
    const app = open("telegram");
    await type(app, "notatoken");
    expect(strip(app.lastFrame())).toContain("Press Enter again");
    expect(strip(app.lastFrame())).toContain("Paste the bot token");
  });

  it("Slack: channel, then skipping two-way leaves it posting only", async () => {
    const app = open("slack");
    await type(app, "xoxb-1-2-abc");
    expect(strip(app.lastFrame())).toContain("/invite @acme_bot");
    await type(app, "");
    await type(app, "");
    expect(loadNotifyConfig(path).channels.slack).toMatchObject({ enabled: true, channel: "#foreman" });
    expect(loadNotifyConfig(path).channels.slack?.app_token_ref).toBeUndefined();
    expect(tested).toEqual(["slack"]);
  });

  it("Slack: two-way with the app token and your member id", async () => {
    const app = open("slack");
    await type(app, "xoxb-1-2-abc");
    await type(app, "");
    await type(app, "xapp-1-abc");
    await type(app, "U0123ABCD");
    expect(loadNotifyConfig(path).channels.slack).toMatchObject({ app_token_ref: "slack-app-token", allowed_user_ids: ["U0123ABCD"] });
  });

  it("Slack: two-way needs both, so an app token without a user stays off", async () => {
    const app = open("slack");
    await type(app, "xoxb-1-2-abc");
    await type(app, "");
    await type(app, "xapp-1-abc");
    await type(app, "");
    expect(loadNotifyConfig(path).channels.slack?.app_token_ref).toBeUndefined();
    expect(store.exists("slack-app-token")).toBe(false);
  });

  it("Discord: shows the invite link, wants a channel id, two-way with your user id", async () => {
    const app = open("discord");
    await type(app, ["a".repeat(24), "b".repeat(6), "c".repeat(30)].join("."));
    expect(strip(app.lastFrame()).replace(/[\s│]+/g, "")).toContain("client_id=42");
    await type(app, "general");
    expect(strip(app.lastFrame())).toContain("right-click the channel");
    await tick();
    for (let i = 0; i < 7; i++) app.stdin.write("\x7f");
    await type(app, "123456789012345678");
    await type(app, "111111111111111111");
    expect(loadNotifyConfig(path).channels.discord).toMatchObject({ channel: "123456789012345678", interactive: true, allowed_user_ids: ["111111111111111111"] });
  });

  it("a test that fails says what to do, and keeps what you typed", async () => {
    api.test = async () => ({ ok: false, reason: "The bot isn't in that channel." });
    const app = open("slack");
    await type(app, "xoxb-1-2-abc");
    await type(app, "");
    await type(app, "");
    expect(done[0]).toBe("Slack is saved, but the test message failed. The bot isn't in that channel.");
    expect(store.exists("slack-bot-token")).toBe(true);
  });

  it("a token you already saved can be kept", async () => {
    store.add("telegram-bot-token", "123:saved");
    const app = open("telegram");
    expect(strip(app.lastFrame())).toContain("Enter keeps the one you saved");
    await type(app, "");
    expect(strip(app.lastFrame())).toContain("press Start");
  });
});
