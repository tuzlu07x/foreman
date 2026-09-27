import { createHmac } from "node:crypto";
import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from "../types.js";
import { FOREMAN_VERSION } from "../../../version.js";

// =============================================================================
// WebhookChannel — generic outbound HTTP POST (#235 / C11b-1)
// =============================================================================
//
// Sends each notification as a JSON POST to a user-configured URL. Includes a
// HMAC-SHA256 signature header so the receiver can verify the payload came
// from Foreman (and wasn't fabricated by an attacker who knows the URL).
//
// **Outbound-only for v0.1.** A bidirectional flow (the user's automation POSTs
// a decision back to Foreman) requires Foreman to expose an HTTP server, which
// is significant new infrastructure. Webhook is shipped as a delivery-only
// integration: route critical/warning alerts to Discord/n8n/Zapier/PagerDuty/
// custom relays via webhook, decide via Telegram or the TUI.

export interface WebhookFetch {
  (
    url: string,
    init: RequestInit,
  ): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface WebhookChannelOptions {
  /** Destination URL. */
  url: string;
  /** Optional HMAC-SHA256 signing secret. When set, every POST carries a
   *  `X-Foreman-Signature: sha256=<hex>` header computed over the raw body. */
  signingSecret?: string;
  /** Override the global fetch (used by tests). */
  fetchImpl?: WebhookFetch;
  /** Request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

/** Why a webhook URL is refused, or null when it's fine (#636). Payloads
 *  describe tool calls, so they only travel over https, except to this
 *  machine. */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the webhook URL is not a valid URL";
  }
  if (url.protocol === "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.protocol === "http:" && loopback) return null;
  return url.protocol === "http:"
    ? "the webhook URL uses plain http:// — use https:// (http is only allowed to localhost)"
    : `the webhook URL must be https:// (got ${url.protocol})`;
}

export class WebhookChannel implements NotificationChannel {
  readonly id = "webhook" as const;

  private readonly url: string;
  private readonly signingSecret: string | null;
  private readonly fetchImpl: WebhookFetch;
  private readonly timeoutMs: number;
  private messageCounter = 0;

  constructor(opts: WebhookChannelOptions) {
    const problem = webhookUrlProblem(opts.url);
    if (problem) throw new WebhookDeliveryError(problem);
    this.url = opts.url;
    this.signingSecret = opts.signingSecret ?? null;
    this.fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init) as never);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async isReady(): Promise<boolean> {
    return this.url.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    const messageId = this.nextMessageId(n);
    await this.post({ ...this.buildPayload(n), kind: "notification", messageId });
    return { channelMessageId: messageId };
  }

  async updateMessage(ref: ChannelMessageRef, body: string, opts?: { final?: boolean }): Promise<void> {
    // A webhook can't edit an earlier delivery, and a follow-up POST per
    // countdown tick would flood the receiver: only the outcome is sent,
    // carrying the original notification's ids so it can be matched (#636).
    if (!opts?.final) return;
    const original = parseMessageId(ref.channelMessageId);
    await this.post({
      schema: "foreman.notification.v1",
      kind: "outcome",
      inReplyTo: ref.channelMessageId,
      id: original?.notificationId ?? ref.channelMessageId,
      requestId: original?.requestId ?? null,
      level: "info",
      title: "Foreman update",
      body,
      actions: [],
      agentBlocking: false,
      sentAt: Date.now(),
    });
  }

  private nextMessageId(n: Notification): string {
    this.messageCounter += 1;
    // The ids travel in the message id, so an outcome sent after a restart
    // still names the approval it belongs to.
    return `webhook:${this.messageCounter}:${encodeURIComponent(n.id)}:${encodeURIComponent(n.requestId ?? "")}`;
  }

  private async post(payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `foreman/${FOREMAN_VERSION}`,
    };
    if (this.signingSecret) {
      headers["x-foreman-signature"] = `sha256=${this.sign(body)}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new WebhookDeliveryError(`HTTP ${res.status}: ${text}`);
    }
  }

  // No inbound endpoint in v0.1 — see file header.
  async listen(_onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    return;
  }

  async shutdown(): Promise<void> {
    return;
  }

  // ============================================================================
  // Internals
  // ============================================================================

  // Receivers verify with:
  //
  //   const expected = "sha256=" + hmacSha256(secret, rawBody);
  //   if (!constantTimeEqual(expected, signatureHeader)) reject();
  //
  private sign(body: string): string {
    if (!this.signingSecret) return "";
    return createHmac("sha256", this.signingSecret).update(body).digest("hex");
  }

  private buildPayload(n: Notification): Record<string, unknown> {
    return {
      schema: "foreman.notification.v1",
      id: n.id,
      level: n.level,
      requestId: n.requestId,
      title: n.title,
      body: n.body,
      actions: n.actions,
      agentBlocking: n.agentBlocking,
      sentAt: Date.now(),
    };
  }
}

function parseMessageId(id: string): { notificationId: string; requestId: string | null } | null {
  const parts = id.split(":");
  if (parts.length !== 4 || parts[0] !== "webhook") return null;
  try {
    const requestId = decodeURIComponent(parts[3]!);
    return { notificationId: decodeURIComponent(parts[2]!), requestId: requestId || null };
  } catch {
    return null;
  }
}

export class WebhookDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDeliveryError";
  }
}
