import { DiscordChannel } from "./channels/discord.js";
import { EmailChannel } from "./channels/email.js";
import type { HttpFetch } from "./channels/http-post.js";
import { NtfyChannel } from "./channels/ntfy.js";
import { SlackChannel } from "./channels/slack.js";
import { SystemNotifyChannel } from "./channels/system.js";
import { TelegramChannel } from "./channels/telegram.js";
import { WebhookChannel } from "./channels/webhook.js";
import { channelConfig, isChannelEnabled, type ChannelToggle, type NotifyConfig } from "./notify-config.js";
import type { SmtpSecurity } from "./smtp.js";
import { KNOWN_CHANNELS, type ChannelId, type NotificationChannel } from "./types.js";

// =============================================================================
// Channel factory — notify.yaml + secret store → live channels
// =============================================================================
//
// The single place that turns a notify.yaml channel block into a channel.
// `foreman start` and `foreman notify test` both use it, so a channel the
// wizard enables is never silently ignored at runtime. That used to be the
// case for Slack and Discord: the wizard wrote them to notify.yaml, but
// start only built telegram / webhook / system.

export interface ChannelSecrets {
  exists(name: string): boolean;
  get(name: string): string;
}

export interface ChannelFactoryDeps {
  secrets: ChannelSecrets;
  /** Approval-token signer for Telegram buttons (see approval-token.ts). */
  signApproval?: (approvalId: string, actionId: string) => string;
  fetchImpl?: HttpFetch;
}

export type ChannelBuild = { channel: NotificationChannel } | { problem: string };

export interface ChannelBuildResult {
  channels: Map<ChannelId, NotificationChannel>;
  /** Enabled channels that could not be built, with the fix. */
  problems: Array<{ channel: ChannelId; problem: string }>;
}

class MissingChannelSecret extends Error {}

export function buildEnabledChannels(config: NotifyConfig, deps: ChannelFactoryDeps): ChannelBuildResult {
  const channels = new Map<ChannelId, NotificationChannel>();
  const problems: ChannelBuildResult["problems"] = [];
  for (const id of KNOWN_CHANNELS) {
    if (!isChannelEnabled(config, id)) continue;
    const built = buildChannel(id, channelConfig(config, id) ?? { enabled: true }, deps);
    if ("channel" in built) channels.set(id, built.channel);
    else problems.push({ channel: id, problem: built.problem });
  }
  return { channels, problems };
}

export function buildChannel(id: ChannelId, toggle: ChannelToggle, deps: ChannelFactoryDeps): ChannelBuild {
  const secret = (ref: string): string => {
    if (!deps.secrets.exists(ref)) {
      throw new MissingChannelSecret(`secret '${ref}' not found — \`foreman secrets add ${ref}\``);
    }
    return deps.secrets.get(ref);
  };
  const fetchImpl = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  try {
    switch (id) {
      case "telegram": {
        if (!toggle.bot_token_ref || !toggle.chat_id) {
          return { problem: "telegram needs bot_token_ref and chat_id in notify.yaml" };
        }
        return {
          channel: new TelegramChannel({
            botToken: secret(toggle.bot_token_ref),
            chatId: toggle.chat_id,
            ...(deps.signApproval ? { signApproval: deps.signApproval } : {}),
          }),
        };
      }
      case "webhook": {
        if (!toggle.webhook_url_ref) return { problem: "webhook needs webhook_url_ref in notify.yaml" };
        return {
          channel: new WebhookChannel({
            url: secret(toggle.webhook_url_ref),
            // A configured-but-missing signing secret keeps the channel off:
            // the receiver expects signed payloads, so never send unsigned.
            ...(toggle.signing_secret_ref ? { signingSecret: secret(toggle.signing_secret_ref) } : {}),
          }),
        };
      }
      case "system":
        return { channel: new SystemNotifyChannel() };
      case "slack": {
        if (toggle.webhook_url_ref) {
          return { channel: new SlackChannel({ target: { kind: "webhook", url: secret(toggle.webhook_url_ref) }, ...fetchImpl }) };
        }
        if (toggle.bot_token_ref && toggle.channel) {
          return {
            channel: new SlackChannel({
              target: { kind: "bot", token: secret(toggle.bot_token_ref), channel: toggle.channel },
              ...fetchImpl,
            }),
          };
        }
        return {
          problem:
            "slack needs webhook_url_ref (incoming webhook), or bot_token_ref + channel — see docs/notifications.md",
        };
      }
      case "discord": {
        if (toggle.webhook_url_ref) {
          return { channel: new DiscordChannel({ target: { kind: "webhook", url: secret(toggle.webhook_url_ref) }, ...fetchImpl }) };
        }
        if (toggle.bot_token_ref && toggle.channel) {
          return {
            channel: new DiscordChannel({
              target: { kind: "bot", token: secret(toggle.bot_token_ref), channelId: toggle.channel },
              ...fetchImpl,
            }),
          };
        }
        return {
          problem:
            "discord needs webhook_url_ref (channel webhook), or bot_token_ref + channel (channel id) — see docs/notifications.md",
        };
      }
      case "email": {
        if (!toggle.smtp_host || !toggle.email_from || !toggle.email_to?.length) {
          return { problem: "email needs smtp_host, email_from and email_to in notify.yaml" };
        }
        const security: SmtpSecurity =
          toggle.smtp_security ?? (toggle.smtp_port === 465 ? "tls" : "starttls");
        const port = toggle.smtp_port ?? (security === "tls" ? 465 : security === "starttls" ? 587 : 25);
        return {
          channel: new EmailChannel({
            smtp: {
              host: toggle.smtp_host,
              port,
              security,
              from: toggle.email_from,
              to: toggle.email_to,
              ...(toggle.smtp_username ? { username: toggle.smtp_username } : {}),
              ...(toggle.password_ref ? { password: secret(toggle.password_ref) } : {}),
            },
          }),
        };
      }
      case "ntfy": {
        if (!toggle.topic_ref) return { problem: "ntfy needs topic_ref — run `foreman notify ntfy-setup`" };
        return {
          channel: new NtfyChannel({
            server: toggle.server ?? "https://ntfy.sh",
            topic: secret(toggle.topic_ref),
            ...(toggle.access_token_ref ? { accessToken: secret(toggle.access_token_ref) } : {}),
            ...fetchImpl,
          }),
        };
      }
    }
  } catch (err) {
    if (err instanceof MissingChannelSecret) return { problem: err.message };
    throw err;
  }
}
