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
import {
  clipText,
  decisionHint,
  defaultFetch,
  outboundUrlProblem,
  postWithTimeout,
  ChannelDeliveryError,
  type HttpFetch,
} from "./http-post.js";
import { slackEndpoints, type SlackEndpoints } from "./slack-endpoints.js";
import { SlackSocketListener, type SlackSocketOptions } from "./slack-socket.js";

// =============================================================================
// Slack — incoming webhook or bot token (chat.postMessage)
// =============================================================================
//
// Outbound alerts and digests. Two setups:
//   - incoming webhook (`webhook_url_ref`): simplest, one channel, no edits;
//   - bot token + channel (`bot_token_ref` + `channel`): lets Foreman edit
//     the message when the approval is resolved elsewhere.
// With an app-level token (`app_token_ref`) the channel is two-way over
// Socket Mode (slack-socket.ts): approval messages get Allow / Deny
// buttons and `/foreman` works in Slack, for the allowed user ids only.

export type SlackTarget =
  | { kind: "webhook"; url: string }
  | { kind: "bot"; token: string; channel: string };

export interface SlackChannelOptions {
  target: SlackTarget;
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
  /** Two-way mode over Socket Mode (#615). */
  interactive?: Omit<SlackSocketOptions, "fetchImpl" | "sign" | "endpoints"> & { sign: ApprovalSigner };
  /** Where Slack is (default: slack.com, see slack-endpoints.ts). */
  endpoints?: SlackEndpoints;
}

export class SlackChannel implements NotificationChannel {
  readonly id = "slack" as const;
  private readonly fetchImpl: HttpFetch;
  private readonly timeoutMs: number;
  private counter = 0;
  private readonly listener: SlackSocketListener | null;
  private readonly endpoints: SlackEndpoints;

  constructor(private readonly opts: SlackChannelOptions) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.endpoints = opts.endpoints ?? slackEndpoints();
    this.listener = opts.interactive
      ? new SlackSocketListener({ ...opts.interactive, fetchImpl: this.fetchImpl, endpoints: this.endpoints })
      : null;
  }

  async isReady(): Promise<boolean> {
    const t = this.opts.target;
    return t.kind === "webhook" ? outboundUrlProblem(t.url, "the webhook URL") === null : t.token.length > 0 && t.channel.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    const payload = renderSlackMessage(n, this.opts.interactive?.sign);
    const t = this.opts.target;
    if (t.kind === "webhook") {
      await this.post(t.url, {}, payload);
      this.counter += 1;
      return { channelMessageId: `slack-webhook-${this.counter}` };
    }
    const res = await this.api(t.token, "chat.postMessage", { channel: t.channel, ...payload });
    return { channelMessageId: `${String(res.channel ?? t.channel)}:${String(res.ts ?? "")}` };
  }

  async updateMessage(ref: ChannelMessageRef, body: string, opts: { final?: boolean } = {}): Promise<void> {
    // Block Kit messages don't show countdown edits (only the fallback text
    // would change), and a webhook can't edit at all: only the outcome is
    // worth a call.
    if (!opts.final) return;
    const t = this.opts.target;
    const text = escapeSlack(clipText(body, 3_000));
    if (t.kind === "webhook") {
      await this.post(t.url, {}, { text });
      return;
    }
    const [channel, ts] = ref.channelMessageId.split(":");
    if (!channel || !ts) return;
    // Replacing the blocks also removes the approval buttons.
    await this.api(t.token, "chat.update", {
      channel,
      ts,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: text || "_(resolved)_" } }],
    });
  }

  async listen(onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    // Push-only unless two-way mode is configured (see file header).
    this.listener?.start(onDecision);
  }

  async shutdown(): Promise<void> {
    await this.listener?.stop();
  }

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
    const text = await this.post(`${this.endpoints.api}/${method}`, { authorization: `Bearer ${token}` }, payload);
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
 *  <!channel> or render links the user didn't expect. With a signer (two-way
 *  mode), approval prompts get HMAC-tagged buttons. */
export function renderSlackMessage(n: Notification, sign?: ApprovalSigner): { text: string; blocks: unknown[] } {
  const title = clipText(n.title, 150);
  const body = escapeSlack(clipText(n.body, 2_900));
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: body || "_(no details)_" } },
  ];
  const buttons = sign && n.requestId ? approvalButtons(n) : [];
  if (buttons.length > 0 && n.requestId) {
    const requestId = n.requestId;
    blocks.push({
      type: "actions",
      block_id: "foreman_approval",
      elements: buttons.map((a) => {
        const style = buttonStyle(a.id);
        return {
          type: "button",
          action_id: `foreman_${a.id}`,
          text: { type: "plain_text", text: clipText(a.label, 70), emoji: true },
          value: encodeApprovalButton(requestId, a.id, sign!),
          ...(style === "neutral" ? {} : { style }),
        };
      }),
    });
  } else {
    const hint = decisionHint(n);
    if (hint) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeSlack(hint) }] });
  }
  return { text: `${title}\n${clipText(n.body, 300)}`, blocks };
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
