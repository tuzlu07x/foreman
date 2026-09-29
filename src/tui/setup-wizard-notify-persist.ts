import {
  addChannelToRoutes,
  type ChannelToggle,
  type NotifyConfig,
} from "../core/notification/notify-config.js";
import type { NotificationLevel } from "../core/notification/types.js";
import type { ServiceEntry } from "../core/registry-catalog.js";

// =============================================================================
// Wizard → notify.yaml persistence (#290)
// =============================================================================
//
// Sibling to setup-wizard-llm-persist.ts. Before this, the services step
// collected bot tokens + chat ids, stashed them in the secret vault, said
// "✓ 2 services telegram, github" on the summary — but notify.yaml never
// landed on disk, so:
//
//   $ foreman notify test telegram
//   error: telegram is not enabled — run `foreman notify enable telegram` first
//
// Pure function so the wizard glue stays thin and the tests stay tight.

export type ChannelId = "telegram" | "discord" | "slack";

// Maps catalog service ids → notify channel ids. Services that aren't
// notification channels (github, atlassian, notion) map to null and get
// skipped. These secrets still land in the vault, they just don't drive a
// notify.yaml block.
const SERVICE_TO_CHANNEL: Record<string, ChannelId | null> = {
  telegram: "telegram",
  discord: "discord",
  slack: "slack",
  github: null,
  atlassian: null,
  notion: null,
};

/** Tiny secret-reader surface — keeps the helper pure-ish + test-friendly. */
export interface SecretReader {
  get(name: string): string;
}

export interface BuildNotifyConfigInput {
  /** Storage names the wizard saved into the secret store (servicesSaved). */
  savedStorageNames: string[];
  /** Service catalog rows used to resolve storage names back to channels. */
  serviceCatalog: ServiceEntry[];
  /** Secret reader — used only to inline non-secret values like chat_id that
   *  the notify schema stores literally rather than via secret ref. */
  secretStore: SecretReader;
  /** Existing notify.yaml content. We merge into this so a user's manual
   *  override of routing (timeouts, default actions) survives a wizard
   *  re-run. */
  existing: NotifyConfig;
  /** The Slack channel / Discord channel id the wizard asked for. A bot
   *  can't post without one (channel-factory.ts buildChannel). */
  channelTargets?: ChannelTargets;
}

/** Where a Slack or Discord bot posts: `channel` in notify.yaml. */
export type ChannelTargets = Partial<Record<"slack" | "discord", string>>;

/** The command that turns a chat app on after setup once its bot token is
 *  stored: it names the chat id / channel the wizard didn't get. */
export function channelFinishCommand(channel: string): string {
  if (channel === "telegram") return "foreman notify enable telegram --chat-id <id>";
  if (channel === "slack") return "foreman notify enable slack --channel '#foreman'";
  return `foreman notify enable ${channel} --channel <channel-id>`;
}

/** A chat app whose bot token is in place but that can't be turned on yet. */
export interface UnwiredChannel {
  channel: ChannelId;
  /** What notify.yaml still lacks, e.g. "chat id". */
  missing: string;
  /** The command that finishes it after setup. */
  finish: string;
}

export interface BuildNotifyConfigResult {
  /** The config to write back; identical to `existing` when nothing was
   *  wired (caller can short-circuit the write). */
  next: NotifyConfig;
  /** Which channels got enabled (dedup'd). Empty when the wizard saved no
   *  channel-relevant secrets. */
  wiredChannels: ChannelId[];
  /** Channels left as they were because their chat id / channel is
   *  missing; each names how to finish it. */
  unwiredChannels: UnwiredChannel[];
}

/**
 * Build notify.yaml from wizard state. For each catalog service that maps
 * to a notification channel, the channel is enabled only when everything
 * its bot needs is in place, so `foreman doctor` can build it:
 *   - the service's primary secret (e.g. telegram-bot-token) was saved (or
 *     is already in the vault) → `bot_token_ref` points at it;
 *   - Telegram also needs chat_id, pulled INLINE from the vault (the notify
 *     schema stores chat_id literally, not as a secret ref — see
 *     ChannelToggleSchema in notify-config.ts);
 *   - Slack and Discord also need `channel` (a channel name / channel id).
 * A missing chat id or channel falls back to the one notify.yaml already
 * has; with neither, the channel is left untouched (never enabled half-set)
 * and reported in `unwiredChannels`.
 */
export function buildNotifyConfigFromWizard(
  input: BuildNotifyConfigInput,
): BuildNotifyConfigResult {
  const wired: ChannelId[] = [];
  const unwired: UnwiredChannel[] = [];
  const channelUpdates: Partial<Record<ChannelId, ChannelToggle>> = {};

  for (const service of input.serviceCatalog) {
    const channel = SERVICE_TO_CHANNEL[service.id];
    if (!channel) continue;
    if (!input.savedStorageNames.includes(service.secret_name)) continue;

    const update: ChannelToggle = {
      enabled: true,
      bot_token_ref: service.secret_name,
    };
    const existing = input.existing.channels[channel];

    if (channel === "telegram") {
      // chat_id lives inline in notify.yaml (not as a secret ref), so we
      // resolve it now.
      const chatIdExtra = service.extra_secrets?.find(
        (e) => e.name === "telegram-chat-id",
      );
      if (
        chatIdExtra &&
        input.savedStorageNames.includes(chatIdExtra.name)
      ) {
        try {
          update.chat_id = input.secretStore.get(chatIdExtra.name);
        } catch {
          // chat_id was nominally saved but couldn't be read — treat it as
          // missing rather than crashing the wizard.
        }
      }
      update.chat_id ??= existing?.chat_id;
      if (!update.chat_id) {
        unwired.push({ channel, missing: "chat id", finish: channelFinishCommand(channel) });
        continue;
      }
    } else {
      const target = input.channelTargets?.[channel]?.trim() || existing?.channel;
      if (!target) {
        unwired.push({
          channel,
          missing: channel === "slack" ? "channel" : "channel id",
          finish: channelFinishCommand(channel),
        });
        continue;
      }
      update.channel = target;
    }

    if (!wired.includes(channel)) wired.push(channel);
    channelUpdates[channel] = update;
  }

  if (wired.length === 0) {
    return { next: input.existing, wiredChannels: [], unwiredChannels: unwired };
  }

  const next: NotifyConfig = {
    ...input.existing,
    channels: {
      ...input.existing.channels,
      ...channelUpdates,
    },
    routing: structuredClone(input.existing.routing),
  };
  // A chat app no level routes to would receive nothing (the default
  // routing names Telegram only, so a Slack or Discord set up here got no
  // approval, alert or digest). It gets those levels; a channel you
  // routed yourself keeps your routing.
  const routed = new Set(Object.values(input.existing.routing).flatMap((r) => r?.channels ?? []));
  for (const channel of wired) {
    if (!routed.has(channel)) addChannelToRoutes(next, channel, WIZARD_CHANNEL_LEVELS);
  }
  return { next, wiredChannels: wired, unwiredChannels: unwired };
}

/** Levels a chat app set up in the wizard receives. */
const WIZARD_CHANNEL_LEVELS: readonly NotificationLevel[] = ["critical", "warning", "risk_deny", "budget_alert", "summary"];
