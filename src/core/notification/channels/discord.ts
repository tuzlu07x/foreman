import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from "../types.js";
import {
  ChannelDeliveryError,
  clipText,
  decisionHint,
  defaultFetch,
  postWithTimeout,
  type HttpFetch,
} from "./http-post.js";

// =============================================================================
// Discord — channel webhook or bot token
// =============================================================================
//
// Outbound alerts and digests as a coloured embed. `allowed_mentions` is
// always empty: notification text can quote agent output, and an agent must
// never be able to make Foreman ping @everyone. Approvals are decided in the
// TUI / Telegram (Discord buttons need Foreman to host an interactions
// endpoint or a gateway connection).

export type DiscordTarget =
  | { kind: "webhook"; url: string }
  | { kind: "bot"; token: string; channelId: string };

export interface DiscordChannelOptions {
  target: DiscordTarget;
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
}

const DISCORD_API = "https://discord.com/api/v10";

const LEVEL_COLOURS: Record<string, number> = {
  critical: 0xff5252,
  risk_deny: 0xff5252,
  warning: 0xff8c42,
  budget_alert: 0xffc542,
  info: 0x4d9de0,
  summary: 0x00d084,
  session_lifecycle: 0x4d9de0,
};

export class DiscordChannel implements NotificationChannel {
  readonly id = "discord" as const;
  private readonly fetchImpl: HttpFetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DiscordChannelOptions) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async isReady(): Promise<boolean> {
    const t = this.opts.target;
    return t.kind === "webhook" ? t.url.startsWith("https://") : t.token.length > 0 && t.channelId.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    const payload = renderDiscordMessage(n);
    const t = this.opts.target;
    const url = t.kind === "webhook" ? withWait(t.url) : `${DISCORD_API}/channels/${t.channelId}/messages`;
    const text = await this.request("POST", url, payload);
    let id = "";
    try {
      id = String((JSON.parse(text) as { id?: unknown }).id ?? "");
    } catch {
      // webhook without ?wait answers 204 — nothing to edit later
    }
    return { channelMessageId: id };
  }

  async updateMessage(ref: ChannelMessageRef, body: string): Promise<void> {
    if (!ref.channelMessageId) return;
    const t = this.opts.target;
    const base = t.kind === "webhook" ? stripQuery(t.url) : `${DISCORD_API}/channels/${t.channelId}`;
    await this.request("PATCH", `${base}/messages/${ref.channelMessageId}`, {
      content: clipText(body, 1_900),
      allowed_mentions: { parse: [] },
    });
  }

  async listen(_onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    // Outbound only — see file header.
  }

  async shutdown(): Promise<void> {}

  private request(method: "POST" | "PATCH", url: string, payload: unknown): Promise<string> {
    const t = this.opts.target;
    return postWithTimeout({
      channel: "discord",
      fetchImpl: this.fetchImpl,
      url,
      method,
      headers: {
        "content-type": "application/json",
        ...(t.kind === "bot" ? { authorization: `Bot ${t.token}` } : {}),
      },
      body: JSON.stringify(payload),
      timeoutMs: this.timeoutMs,
    }).catch((err: unknown) => {
      if (err instanceof ChannelDeliveryError) throw err;
      throw new ChannelDeliveryError("discord", 0, "request failed");
    });
  }
}

export function renderDiscordMessage(n: Notification): unknown {
  const hint = decisionHint(n);
  return {
    embeds: [
      {
        title: clipText(n.title, 250),
        description: clipText(n.body, 3_900) || "(no details)",
        color: LEVEL_COLOURS[n.level] ?? 0x4d9de0,
        ...(hint ? { footer: { text: hint } } : {}),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function withWait(url: string): string {
  return url.includes("?") ? `${url}&wait=true` : `${url}?wait=true`;
}

function stripQuery(url: string): string {
  const at = url.indexOf("?");
  return at === -1 ? url : url.slice(0, at);
}
