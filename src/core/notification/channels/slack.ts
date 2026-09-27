import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from "../types.js";
import {
  clipText,
  decisionHint,
  defaultFetch,
  postWithTimeout,
  ChannelDeliveryError,
  type HttpFetch,
} from "./http-post.js";

// =============================================================================
// Slack — incoming webhook or bot token (chat.postMessage)
// =============================================================================
//
// Outbound alerts and digests. Two setups:
//   - incoming webhook (`webhook_url_ref`): simplest, one channel, no edits;
//   - bot token + channel (`bot_token_ref` + `channel`): lets Foreman edit
//     the message when the approval is resolved elsewhere.
// Interactive buttons need Slack to reach Foreman (a public URL or Socket
// Mode), so approvals are decided in the TUI / Telegram for now.

export type SlackTarget =
  | { kind: "webhook"; url: string }
  | { kind: "bot"; token: string; channel: string };

export interface SlackChannelOptions {
  target: SlackTarget;
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
}

const SLACK_API = "https://slack.com/api";

export class SlackChannel implements NotificationChannel {
  readonly id = "slack" as const;
  private readonly fetchImpl: HttpFetch;
  private readonly timeoutMs: number;
  private counter = 0;

  constructor(private readonly opts: SlackChannelOptions) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async isReady(): Promise<boolean> {
    const t = this.opts.target;
    return t.kind === "webhook" ? t.url.startsWith("https://") : t.token.length > 0 && t.channel.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    const payload = renderSlackMessage(n);
    const t = this.opts.target;
    if (t.kind === "webhook") {
      await this.post(t.url, {}, payload);
      this.counter += 1;
      return { channelMessageId: `slack-webhook-${this.counter}` };
    }
    const res = await this.api(t.token, "chat.postMessage", { channel: t.channel, ...payload });
    return { channelMessageId: `${String(res.channel ?? t.channel)}:${String(res.ts ?? "")}` };
  }

  async updateMessage(ref: ChannelMessageRef, body: string): Promise<void> {
    const t = this.opts.target;
    const text = escapeSlack(clipText(body, 3_000));
    if (t.kind === "webhook") {
      await this.post(t.url, {}, { text });
      return;
    }
    const [channel, ts] = ref.channelMessageId.split(":");
    if (!channel || !ts) return;
    await this.api(t.token, "chat.update", { channel, ts, text });
  }

  async listen(_onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    // Outbound only — see file header.
  }

  async shutdown(): Promise<void> {}

  private async post(url: string, headers: Record<string, string>, payload: unknown): Promise<string> {
    return postWithTimeout({
      channel: "slack",
      fetchImpl: this.fetchImpl,
      url,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      timeoutMs: this.timeoutMs,
    });
  }

  private async api(token: string, method: string, payload: unknown): Promise<Record<string, unknown>> {
    const text = await this.post(`${SLACK_API}/${method}`, { authorization: `Bearer ${token}` }, payload);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ChannelDeliveryError("slack", 200, "unparseable API response");
    }
    // Slack reports failures as HTTP 200 + { ok: false, error }.
    if (parsed.ok !== true) {
      throw new ChannelDeliveryError("slack", 200, String(parsed.error ?? "unknown error"));
    }
    return parsed;
  }
}

/** Block Kit payload. Agent-influenced text is escaped so it can't ping
 *  <!channel> or render links the user didn't expect. */
export function renderSlackMessage(n: Notification): { text: string; blocks: unknown[] } {
  const title = clipText(n.title, 150);
  const body = escapeSlack(clipText(n.body, 2_900));
  const hint = decisionHint(n);
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: body || "_(no details)_" } },
  ];
  if (hint) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeSlack(hint) }] });
  return { text: `${title}\n${clipText(n.body, 300)}`, blocks };
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
