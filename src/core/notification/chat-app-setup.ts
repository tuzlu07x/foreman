import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SecretStore } from "../secret-store.js";
import { buildChannel, type ChannelFactoryDeps } from "./channel-factory.js";
import { DEFAULT_CHANNEL_SECRETS, planChannelEnable } from "./channel-setup.js";
import {
  channelConfig,
  defaultNotifyConfig,
  loadNotifyConfig,
  routeNewChannel,
  saveNotifyConfig,
  type ChannelToggle,
  type NotifyConfig,
} from "./notify-config.js";
import type { TokenCheck } from "./token-checks.js";
import type { Notification } from "./types.js";

// =============================================================================
// Connecting a chat app: one path for the TUI and the CLI
// =============================================================================
//
// Telegram, Slack and Discord each need a token and somewhere to post, in
// notify.yaml, before anything reaches you. The Services page used to store
// the token, say "configured" and stop there, so nothing was ever sent. This
// is the whole job: save the values, turn the channel on, route it, and send
// a test message so you know it works.

export type ChatAppId = "telegram" | "slack" | "discord";

export const CHAT_APPS: readonly ChatAppId[] = ["telegram", "slack", "discord"];

/** Vault names of the tokens a chat app can hold. */
export const CHAT_APP_TOKEN: Record<ChatAppId, string> = {
  telegram: DEFAULT_CHANNEL_SECRETS.telegramBotToken,
  slack: DEFAULT_CHANNEL_SECRETS.slackBotToken,
  discord: DEFAULT_CHANNEL_SECRETS.discordBotToken,
};
export const SLACK_APP_TOKEN = "slack-app-token";

export const CHAT_APP_NAME: Record<ChatAppId, string> = { telegram: "Telegram", slack: "Slack", discord: "Discord" };

/** What to do in the app so Foreman can take your Allow / Deny, beyond the
 *  sending set-up. Shown in the guide. */
export const TWO_WAY_GUIDE: Record<ChatAppId, readonly string[]> = {
  telegram: [
    "Nothing more to do: the same bot takes your Allow / Deny taps, /foreman commands and questions",
    "Press Start in the bot's chat once; Telegram requires it",
  ],
  slack: [
    "In api.slack.com/apps → your app: Socket Mode → on",
    "Basic Information → App-Level Tokens → Generate, with connections:write → copy it (xapp-…)",
    "Interactivity & Shortcuts → on (no URL needed with Socket Mode)",
    "Slash Commands → create /foreman",
    "Reinstall the app if Slack asks",
  ],
  discord: [
    "Turn on Developer Mode: User Settings → Advanced",
    "Right-click yourself → Copy User ID: only that user may press Allow / Deny or run /foreman",
  ],
};

export interface ChatAppValues {
  /** A new bot token; left out when the stored one is kept. */
  token?: string;
  /** Telegram's chat id. */
  chatId?: string;
  /** Slack channel (name or id) or Discord channel id. */
  target?: string;
  /** Slack's app-level token, for two-way. */
  appToken?: string;
  /** Who may decide and command, for two-way Slack and Discord. */
  userId?: string;
}

/** A secret stored under `name`, new or replacing the old one. */
function storeSecret(store: SecretStore, name: string, value: string): void {
  if (store.exists(name)) store.rotate(name, value);
  else store.add(name, value);
}

function loadOrDefault(path: string): NotifyConfig {
  return existsSync(path) ? loadNotifyConfig(path) : defaultNotifyConfig();
}

function setChannel(config: NotifyConfig, id: string, toggle: ChannelToggle): void {
  (config.channels as Record<string, ChannelToggle | undefined>)[id] = toggle;
}

/** Save everything a chat app needs and turn it on. Returns the channel as
 *  it now stands in notify.yaml. */
export function saveChatApp(id: ChatAppId, values: ChatAppValues, deps: { store: SecretStore; notifyConfigPath: string }): ChannelToggle {
  const { store, notifyConfigPath } = deps;
  if (values.token) storeSecret(store, CHAT_APP_TOKEN[id], values.token);
  if (values.appToken) storeSecret(store, SLACK_APP_TOKEN, values.appToken);
  const config = loadOrDefault(notifyConfigPath);
  const { toggle } = planChannelEnable({
    channel: id,
    existing: channelConfig(config, id),
    hasSecret: (name) => store.exists(name),
    readSecret: (name) => (store.exists(name) ? store.get(name, { touch: false }) : null),
    ...(values.chatId ? { chatId: values.chatId } : {}),
    ...(values.target ? { target: values.target } : {}),
  });
  if (values.userId) {
    toggle.allowed_user_ids = [...new Set([values.userId, ...(toggle.allowed_user_ids ?? [])])];
    if (toggle.owner_user_ids) toggle.owner_user_ids = [...new Set([values.userId, ...toggle.owner_user_ids])];
    if (id === "slack" && (values.appToken || store.exists(SLACK_APP_TOKEN))) toggle.app_token_ref = SLACK_APP_TOKEN;
    if (id === "discord") toggle.interactive = true;
  }
  setChannel(config, id, toggle);
  routeNewChannel(config, id);
  saveNotifyConfig(notifyConfigPath, config);
  return toggle;
}

/** Stop a chat app: its token goes, and notify.yaml stops pointing at it,
 *  or the gateway would warn about a missing secret on every start. */
export function removeChatApp(id: ChatAppId, deps: { store: SecretStore; notifyConfigPath: string }): void {
  const { store, notifyConfigPath } = deps;
  if (store.exists(CHAT_APP_TOKEN[id])) store.remove(CHAT_APP_TOKEN[id]);
  if (!existsSync(notifyConfigPath)) return;
  const config = loadNotifyConfig(notifyConfigPath);
  const toggle = channelConfig(config, id);
  if (!toggle) return;
  setChannel(config, id, { ...toggle, enabled: false });
  saveNotifyConfig(notifyConfigPath, config);
}

/** Can this channel send: on, with its credentials and target in place? */
export function chatAppReady(id: ChatAppId, toggle: ChannelToggle | null, hasSecret: (name: string) => boolean): boolean {
  if (!toggle?.enabled) return false;
  if (id === "telegram") return Boolean(toggle.bot_token_ref && toggle.chat_id && hasSecret(toggle.bot_token_ref));
  if (toggle.webhook_url_ref) return hasSecret(toggle.webhook_url_ref);
  return Boolean(toggle.bot_token_ref && toggle.channel && hasSecret(toggle.bot_token_ref));
}

export type TestResult = { ok: true } | { ok: false; reason: string };

/** Send one test message on `id`, whatever notify.yaml routes. */
export async function sendChatAppTest(
  id: ChatAppId,
  toggle: ChannelToggle,
  deps: ChannelFactoryDeps,
  source: string,
): Promise<TestResult> {
  const built = buildChannel(id, toggle, deps);
  if ("problem" in built) return { ok: false, reason: built.problem };
  const test: Notification = {
    id: `test-${randomUUID()}`,
    level: "info",
    requestId: null,
    title: "Foreman test ✓",
    body: `This chat is connected to Foreman. Sent from ${source}.`,
    actions: [],
    agentBlocking: false,
  };
  try {
    await built.channel.send(test);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: explainDeliveryError(id, err instanceof Error ? err.message : String(err)) };
  } finally {
    await built.channel.shutdown().catch(() => undefined);
  }
}

// =============================================================================
// Telegram: finding your chat, so you don't have to
// =============================================================================

export interface TelegramChat {
  chatId: string;
  name: string;
}

interface TelegramUpdate {
  message?: { chat?: { id?: unknown; type?: unknown; first_name?: unknown; username?: unknown } };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The private chat that last messaged this bot, or null when none has. A
 *  group doesn't count: approvals belong in your own chat, which is also the
 *  only place Foreman accepts them. Anyone can message a bot, so show the
 *  name and ask before using it: this decides who gets your approvals. */
export async function findTelegramChat(token: string, fetchFn: FetchFn = fetch): Promise<TokenCheck<TelegramChat | null>> {
  let res: Response;
  try {
    res = await fetchFn(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=50`, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; description?: unknown; result?: unknown } | null;
  if (body?.ok !== true || !Array.isArray(body.result)) {
    return { status: "rejected", detail: typeof body?.description === "string" ? body.description : null };
  }
  for (const update of [...(body.result as TelegramUpdate[])].reverse()) {
    const chat = update.message?.chat;
    if (chat?.type !== "private" || typeof chat.id !== "number") continue;
    const name = typeof chat.first_name === "string" ? chat.first_name : typeof chat.username === "string" ? chat.username : "your chat";
    return { status: "ok", value: { chatId: String(chat.id), name } };
  }
  return { status: "ok", value: null };
}

// =============================================================================
// Why it didn't work, in words you can act on
// =============================================================================

const EXPLANATIONS: Record<ChatAppId, ReadonlyArray<[RegExp, string]>> = {
  telegram: [
    [/\b401\b|unauthorized/i, "Telegram rejected the bot token. Copy it again from @BotFather (/mybots → your bot → API Token)."],
    [/chat not found/i, "Telegram can't find that chat. Open your bot in Telegram, press Start and send it a message, then try again."],
    [/blocked by the user/i, "You blocked the bot in Telegram. Open its chat, unblock it and try again."],
    [/bots can't send messages to bots/i, "That chat id is a bot. Use your own chat id."],
  ],
  slack: [
    [/invalid_auth|not_authed|account_inactive|token_revoked|token_expired/i, "Slack rejected the bot token. Copy the Bot User OAuth Token (xoxb-…) again from api.slack.com/apps → OAuth & Permissions."],
    [/not_in_channel/i, "The bot isn't in that channel. Open the channel in Slack and type /invite @your-bot, then try again."],
    [/channel_not_found/i, "Slack can't find that channel. For a private channel, invite the bot first (/invite @your-bot); check the name too."],
    [/missing_scope/i, "The Slack app needs the chat:write scope. Add it under OAuth & Permissions → Bot Token Scopes, then reinstall the app."],
    [/is_archived/i, "That Slack channel is archived. Pick another one."],
  ],
  discord: [
    [/\b401\b|unauthorized/i, "Discord rejected the bot token. Reset it under discord.com/developers → your app → Bot → Reset Token, and copy it again."],
    [/\b50001\b|missing access/i, "The bot can't see that channel. Add it to your server with the invite link, and let it view the channel."],
    [/\b50013\b|missing permissions/i, "The bot can't post there. Give it Send Messages and Embed Links in that channel."],
    [/\b10003\b|unknown channel|\b404\b/i, "Discord can't find that channel. Use the channel id: right-click the channel → Copy Channel ID (Developer Mode must be on)."],
    [/\b403\b/i, "Discord refused the message. Add the bot to your server with the invite link, and let it post in that channel."],
  ],
};

const NETWORK = /fetch failed|enotfound|econnrefused|econnreset|etimedout|timed? ?out|aborted|network|getaddrinfo/i;

/** One line that says what went wrong and what to do. */
export function explainDeliveryError(id: ChatAppId, raw: string): string {
  const name = CHAT_APP_NAME[id];
  if (NETWORK.test(raw)) return `Couldn't reach ${name}. Check your internet connection and try again.`;
  for (const [pattern, text] of EXPLANATIONS[id]) {
    if (pattern.test(raw)) return text;
  }
  return `${name} didn't take the message: ${raw.slice(0, 200)}`;
}

/** Where a test that worked should send your eyes, and what's left. */
export function restartHint(attached: boolean): string {
  return attached
    ? "Approvals start arriving after the background service restarts: foreman service install"
    : "Approvals start arriving after you restart Foreman: press q, then foreman start";
}
