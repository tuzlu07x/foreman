import { eq } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { chatPrimary } from "../db/schema.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";

// =============================================================================
// Primary chat agent service (#426)
// =============================================================================
//
// Tracks which registered agent is the "primary" chat consumer for each
// messaging channel (telegram / discord / slack / ...). Multiple
// chat-capable agents can be registered at once, but Telegram + Discord
// + Slack each accept only one bot consumer at a time. The primary slot
// resolves the conflict deterministically:
//
//   - Setup wizard prompts the user when N>1 chat_capable agents are
//     selected together with a messaging service.
//   - The projector consults `getPrimary(channel)` and skips
//     channel-related env_vars + json_channels writes for agents that
//     aren't the primary.
//   - `foreman chat set-primary <channel> <agent>` rewrites the row at
//     runtime. The next `foreman start` (or a `foreman secrets repush`)
//     re-projects with the new primary.
//
// One row per channel; PK on `channel` enforces "at most one primary
// per channel" at the schema level.

export interface ChatPrimaryRow {
  channel: string;
  agentId: string;
  setAt: number;
}

export class ChatPrimaryService {
  private readonly bus: EventBus<ForemanEventMap>;

  constructor(
    private readonly db: ForemanDb,
    opts: { bus?: EventBus<ForemanEventMap> } = {},
  ) {
    this.bus = opts.bus ?? defaultBus;
  }

  /** Returns the primary row for a channel, or null when unset. */
  get(channel: string): ChatPrimaryRow | null {
    const row = this.db
      .select()
      .from(chatPrimary)
      .where(eq(chatPrimary.channel, channel))
      .get();
    return row ?? null;
  }

  /** Lists every channel that has a primary configured. */
  list(): ChatPrimaryRow[] {
    return this.db.select().from(chatPrimary).all();
  }

  /** Sets (or overwrites) the primary agent for a channel. Emits a bus
   *  event so the TUI / settings page can refresh. */
  set(channel: string, agentId: string): void {
    const now = Date.now();
    const existing = this.get(channel);
    if (existing) {
      this.db
        .update(chatPrimary)
        .set({ agentId, setAt: now })
        .where(eq(chatPrimary.channel, channel))
        .run();
    } else {
      this.db
        .insert(chatPrimary)
        .values({ channel, agentId, setAt: now })
        .run();
    }
    this.bus.emit("chat-primary:changed", {
      channel,
      agentId,
      previousAgentId: existing?.agentId ?? null,
      setAt: now,
    });
  }

  /** Removes the primary row for a channel. After this, the projector
   *  falls back to legacy behavior (every agent gets the channel's
   *  secrets — caller is responsible for the consequences). */
  unset(channel: string): void {
    const existing = this.get(channel);
    if (!existing) return;
    this.db
      .delete(chatPrimary)
      .where(eq(chatPrimary.channel, channel))
      .run();
    this.bus.emit("chat-primary:changed", {
      channel,
      agentId: null,
      previousAgentId: existing.agentId,
      setAt: Date.now(),
    });
  }

  /** True when `agentId` is the configured primary for `channel`. Used
   *  by the projector to gate channel-related writes. When no primary
   *  is configured, returns true — preserves backward-compat for any
   *  setup that never went through the wizard's primary picker. */
  isPrimary(channel: string, agentId: string): boolean {
    const row = this.get(channel);
    if (!row) return true; // no primary set → all agents allowed (legacy)
    return row.agentId === agentId;
  }
}
