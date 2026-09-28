import type { ChannelToggle } from "./notify-config.js";
import type { ChannelId } from "./types.js";

// =============================================================================
// `foreman notify enable <channel>` — point a channel at its credentials (#657)
// =============================================================================
//
// `enable` used to flip `enabled: true` and nothing else, so `notify test
// telegram` then failed with "telegram needs bot_token_ref and chat_id",
// even with the documented secrets stored. This fills the refs with the
// documented default secret names (keeping any the user already set),
// takes the chat / channel id from a flag, the existing config or the
// wizard's `telegram-chat-id`, and lists what is still missing.

/** Default secret names, as docs/notifications.md documents them. */
export const DEFAULT_CHANNEL_SECRETS = {
  telegramBotToken: "telegram-bot-token",
  telegramChatId: "telegram-chat-id",
  slackWebhookUrl: "slack-webhook-url",
  slackBotToken: "slack-bot-token",
  discordWebhookUrl: "discord-webhook-url",
  discordBotToken: "discord-bot-token",
  webhookUrl: "webhook-url",
  webhookSecret: "webhook-secret",
} as const;

export interface ChannelEnableInput {
  channel: ChannelId;
  existing: ChannelToggle | null;
  hasSecret: (name: string) => boolean;
  /** Reads a stored value (the wizard keeps the Telegram chat id as one);
   *  null when absent or unreadable. */
  readSecret: (name: string) => string | null;
  /** `--chat-id`: Telegram chat id. */
  chatId?: string;
  /** `--channel`: Slack channel name or Discord channel id (bot mode). */
  target?: string;
}

export interface ChannelEnablePlan {
  toggle: ChannelToggle;
  /** What still has to happen before the channel can send, one step each. */
  missing: string[];
}

export function planChannelEnable(input: ChannelEnableInput): ChannelEnablePlan {
  const existing = input.existing ?? { enabled: false };
  const toggle: ChannelToggle = { ...existing, enabled: true };
  const missing: string[] = [];
  const needSecret = (ref: string, what: string): void => {
    if (!input.hasSecret(ref)) missing.push(`store the ${what}: foreman secrets add ${ref}`);
  };
  switch (input.channel) {
    case "telegram": {
      toggle.bot_token_ref = existing.bot_token_ref ?? DEFAULT_CHANNEL_SECRETS.telegramBotToken;
      const chatId =
        input.chatId?.trim() || existing.chat_id || input.readSecret(DEFAULT_CHANNEL_SECRETS.telegramChatId)?.trim();
      if (chatId) toggle.chat_id = chatId;
      needSecret(toggle.bot_token_ref, "bot token");
      if (!toggle.chat_id) missing.push("give the chat id: foreman notify enable telegram --chat-id <id> (your DM or group with the bot)");
      break;
    }
    case "slack":
    case "discord": {
      const webhookRef =
        input.channel === "slack" ? DEFAULT_CHANNEL_SECRETS.slackWebhookUrl : DEFAULT_CHANNEL_SECRETS.discordWebhookUrl;
      const botRef = input.channel === "slack" ? DEFAULT_CHANNEL_SECRETS.slackBotToken : DEFAULT_CHANNEL_SECRETS.discordBotToken;
      // A bot (token + channel) when asked for one or already set up that
      // way, or when only its token is stored; an incoming webhook otherwise.
      const botMode =
        input.target !== undefined ||
        (existing.bot_token_ref !== undefined && existing.webhook_url_ref === undefined) ||
        (existing.webhook_url_ref === undefined && input.hasSecret(botRef) && !input.hasSecret(webhookRef));
      if (botMode) {
        toggle.bot_token_ref = existing.bot_token_ref ?? botRef;
        if (input.target?.trim()) toggle.channel = input.target.trim();
        needSecret(toggle.bot_token_ref, `${input.channel} bot token`);
        if (!toggle.channel) {
          missing.push(
            input.channel === "slack"
              ? "name the channel: foreman notify enable slack --channel <#channel>"
              : "give the channel id: foreman notify enable discord --channel <channel-id>",
          );
        }
      } else {
        toggle.webhook_url_ref = existing.webhook_url_ref ?? webhookRef;
        needSecret(toggle.webhook_url_ref, `${input.channel} webhook URL`);
      }
      break;
    }
    case "webhook": {
      toggle.webhook_url_ref = existing.webhook_url_ref ?? DEFAULT_CHANNEL_SECRETS.webhookUrl;
      if (!toggle.signing_secret_ref && input.hasSecret(DEFAULT_CHANNEL_SECRETS.webhookSecret)) {
        toggle.signing_secret_ref = DEFAULT_CHANNEL_SECRETS.webhookSecret;
      }
      needSecret(toggle.webhook_url_ref, "webhook URL");
      break;
    }
    case "ntfy":
      if (!toggle.topic_ref) missing.push("set it up: foreman notify ntfy-setup");
      break;
    case "email":
      if (!toggle.smtp_host || !toggle.email_from || !toggle.email_to?.length) {
        missing.push("set smtp_host, email_from and email_to under channels.email in notify.yaml (docs/notifications.md)");
      }
      // Name the setting, not its value: the ref is only a secret's name,
      // but nothing read from a password field is ever printed.
      if (toggle.password_ref && !input.hasSecret(toggle.password_ref)) {
        missing.push("store the SMTP password under the secret name in channels.email.password_ref: foreman secrets add <that name>");
      }
      break;
    case "system":
      break;
  }
  return { toggle, missing };
}
