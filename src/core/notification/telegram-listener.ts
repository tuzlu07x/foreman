import type { RegisteredAgent } from "../registry.js";
import type { ChannelToggle } from "./notify-config.js";

// =============================================================================
// Who reads the Telegram bot's updates: Foreman or a chat agent
// =============================================================================
//
// Telegram lets one process call getUpdates on a bot; a second one gets
// 409 Conflict. When a chat agent (Hermes, OpenClaw, …) talks to you over
// the same bot, that agent reads its updates and Foreman only sends
// (#406); approvals then go through a second bot only Foreman reads (#610).
// When no agent uses the bot, nothing else reads it, so Foreman does: one
// bot carries notifications, approval buttons and `/foreman`.

export type TelegramListener = "foreman" | "agent";

/** A catalog entry, as far as sharing the Telegram bot goes. */
export interface ChatCatalogEntry {
  id: string;
  chat_capable?: boolean;
  optional_services?: string[];
}

/** Registered, active agents that can talk over Telegram, and so may read
 *  the bot's updates: their catalog entry is chat-capable and lists
 *  telegram. */
export function agentsSharingTelegram(
  agents: Pick<RegisteredAgent, "id" | "status" | "metadata">[],
  catalog: ChatCatalogEntry[],
): string[] {
  const chatty = new Set(
    catalog.filter((e) => e.chat_capable === true && (e.optional_services ?? []).includes("telegram")).map((e) => e.id),
  );
  return agents
    .filter((a) => a.status !== "blocked" && a.status !== "disabled")
    .filter((a) => {
      const registryId = typeof a.metadata?.registryId === "string" ? a.metadata.registryId : a.id;
      return chatty.has(registryId);
    })
    .map((a) => a.id);
}

/** notify.yaml's `listener` when set, else Foreman unless an agent may be
 *  reading the bot. */
export function resolveTelegramListener(toggle: Pick<ChannelToggle, "listener">, sharedWith: string[]): TelegramListener {
  if (toggle.listener === "foreman" || toggle.listener === "agent") return toggle.listener;
  return sharedWith.length > 0 ? "agent" : "foreman";
}
