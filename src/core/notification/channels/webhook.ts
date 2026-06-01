import { createHmac } from "node:crypto";
import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from "../types.js";

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

export class WebhookChannel implements NotificationChannel {
  readonly id = "webhook" as const;

  private readonly url: string;
  private readonly signingSecret: string | null;
  private readonly fetchImpl: WebhookFetch;
  private readonly timeoutMs: number;
  private messageCounter = 0;

  constructor(opts: WebhookChannelOptions) {
    this.url = opts.url;
    this.signingSecret = opts.signingSecret ?? null;
    this.fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init) as never);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async isReady(): Promise<boolean> {
    return this.url.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    this.messageCounter += 1;
    const body = JSON.stringify(this.buildPayload(n));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "foreman/0.1.2",
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
    return { channelMessageId: `webhook-${this.messageCounter}` };
  }

  async updateMessage(ref: ChannelMessageRef, body: string): Promise<void> {
    // Webhooks have no concept of "edit an earlier delivery" — send a fresh
    // follow-up POST instead. Receivers can correlate via the notificationId.
    void ref;
    await this.send({
      id: ref.channelMessageId,
      level: "info",
      requestId: null,
      title: "Foreman update",
      body,
      actions: [],
      agentBlocking: false,
    });
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

  private buildPayload(n: Notification): unknown {
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

export class WebhookDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDeliveryError";
  }
}
