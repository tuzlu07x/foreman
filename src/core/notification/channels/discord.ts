import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from "../types.js";
import {
  approvalButtons,
  buttonStyle,
  encodeApprovalButton,
  type ApprovalSigner,
} from "./approval-buttons.js";
import { DiscordGatewayListener, type DiscordGatewayOptions } from "./discord-gateway.js";
import {
  ChannelDeliveryError,
  clipText,
  decisionHint,
  defaultFetch,
  outboundUrlProblem,
  postWithTimeout,
  type HttpFetch,
} from "./http-post.js";

// =============================================================================
// Discord — channel webhook or bot token
// =============================================================================
//
// Outbound alerts and digests as a coloured embed. `allowed_mentions` is
// always empty: notification text can quote agent output, and an agent must
// never be able to make Foreman ping @everyone.
//
// With a bot token and `interactive: true`, the channel is two-way over the
// Gateway (discord-gateway.ts): approval messages get buttons and
// `/foreman` works, for the allowed user ids only.

export type DiscordTarget =
  | { kind: "webhook"; url: string }
  | { kind: "bot"; token: string; channelId: string };

export interface DiscordChannelOptions {
  target: DiscordTarget;
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
  /** Two-way mode over the Gateway (#615). Needs the bot target. */
  interactive?: Omit<DiscordGatewayOptions, "fetchImpl" | "sign" | "botToken"> & { sign: ApprovalSigner };
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
  private readonly listener: DiscordGatewayListener | null;

  constructor(private readonly opts: DiscordChannelOptions) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    const t = opts.target;
    this.listener =
      opts.interactive && t.kind === "bot"
        ? new DiscordGatewayListener({ ...opts.interactive, botToken: t.token, fetchImpl: this.fetchImpl })
        : null;
  }

  async isReady(): Promise<boolean> {
    const t = this.opts.target;
    return t.kind === "webhook" ? outboundUrlProblem(t.url, "the webhook URL") === null : t.token.length > 0 && t.channelId.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    const payload = renderDiscordMessage(n, this.listener ? this.opts.interactive?.sign : undefined);
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

  async updateMessage(ref: ChannelMessageRef, body: string, opts: { final?: boolean } = {}): Promise<void> {
    if (!ref.channelMessageId) return;
    const t = this.opts.target;
    const base = t.kind === "webhook" ? stripQuery(t.url) : `${DISCORD_API}/channels/${t.channelId}`;
    await this.request("PATCH", `${base}/messages/${ref.channelMessageId}`, {
      content: clipText(body, 1_900),
      // The outcome removes the approval buttons.
      ...(opts.final ? { components: [] } : {}),
      allowed_mentions: { parse: [] },
    });
  }

  async listen(onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    // Push-only unless two-way mode is configured (see file header).
    this.listener?.start(onDecision);
  }

  async shutdown(): Promise<void> {
    await this.listener?.stop();
  }

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

const BUTTON_STYLE = { primary: 3, danger: 4, neutral: 2 } as const;

/** With a signer (two-way mode), approval prompts get HMAC-tagged buttons. */
export function renderDiscordMessage(n: Notification, sign?: ApprovalSigner): unknown {
  const buttons = sign && n.requestId ? approvalButtons(n) : [];
  const hint = buttons.length > 0 ? "" : decisionHint(n);
  const requestId = n.requestId ?? "";
  return {
    embeds: [
      {
        title: clipText(n.title, 250),
        description: clipText(n.body, 3_900) || "(no details)",
        color: LEVEL_COLOURS[n.level] ?? 0x4d9de0,
        ...(hint ? { footer: { text: hint } } : {}),
      },
    ],
    ...(buttons.length > 0
      ? {
          components: [
            {
              type: 1,
              components: buttons.map((a) => ({
                type: 2,
                style: BUTTON_STYLE[buttonStyle(a.id)],
                label: clipText(a.label, 80),
                custom_id: encodeApprovalButton(requestId, a.id, sign!),
              })),
            },
          ],
        }
      : {}),
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
