import type {
  ChannelToggle,
  NotifyConfig,
} from "../core/notification/notify-config.js";
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
}

export interface BuildNotifyConfigResult {
  /** The config to write back; identical to `existing` when nothing was
   *  wired (caller can short-circuit the write). */
  next: NotifyConfig;
  /** Which channels got enabled (dedup'd). Empty when the wizard saved no
   *  channel-relevant secrets. */
  wiredChannels: ChannelId[];
}

/**
 * Build notify.yaml from wizard state. For each catalog service that maps
 * to a notification channel:
 *   - if the service's primary secret (e.g. telegram-bot-token) was saved,
 *     enable the channel with `bot_token_ref` pointing at that secret;
 *   - for Telegram specifically, pull chat_id INLINE from the vault (the
 *     notify schema stores chat_id literally, not as a secret ref — see
 *     ChannelToggleSchema in notify-config.ts).
 */
export function buildNotifyConfigFromWizard(
  input: BuildNotifyConfigInput,
): BuildNotifyConfigResult {
  const wired: ChannelId[] = [];
  const channelUpdates: Partial<Record<ChannelId, ChannelToggle>> = {};

  for (const service of input.serviceCatalog) {
    const channel = SERVICE_TO_CHANNEL[service.id];
    if (!channel) continue;
    if (!input.savedStorageNames.includes(service.secret_name)) continue;

    const update: ChannelToggle = {
      enabled: true,
      bot_token_ref: service.secret_name,
    };

    if (channel === "telegram") {
      // chat_id lives inline in notify.yaml (not as a secret ref), so we
      // resolve it now. If the user skipped the chat_id prompt the wizard
      // still wired the bot token — channel goes enabled=true with chat_id
      // undefined; runtime will surface "missing credentials" until the
      // user adds it via `foreman notify` or by editing the YAML.
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
          // chat_id was nominally saved but couldn't be read — leave the
          // field unset rather than crashing the wizard.
        }
      }
    }

    if (!wired.includes(channel)) wired.push(channel);
    channelUpdates[channel] = update;
  }

  if (wired.length === 0) {
    return { next: input.existing, wiredChannels: [] };
  }

  return {
    next: {
      ...input.existing,
      channels: {
        ...input.existing.channels,
        ...channelUpdates,
      },
    },
    wiredChannels: wired,
  };
}
