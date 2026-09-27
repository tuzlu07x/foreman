import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  NotificationLevel,
  UserDecision,
} from "../types.js";
import { clipText, decisionHint, defaultFetch, postWithTimeout, type HttpFetch } from "./http-post.js";

// =============================================================================
// ntfy — phone push notifications with no account or bot setup
// =============================================================================
//
// Install the ntfy app (iOS / Android / desktop), subscribe to a topic,
// done. `foreman notify ntfy-setup` generates an unguessable topic name and
// stores it in the secret store. On the public ntfy.sh server the topic
// name is the only secret, so the message body is already secret-redacted
// and carries no approval token; a self-hosted server or an access token
// (`access_token_ref`) tightens it further.

export interface NtfyChannelOptions {
  /** Server base URL, e.g. https://ntfy.sh (no trailing slash needed). */
  server: string;
  topic: string;
  accessToken?: string;
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
}

const PRIORITY: Partial<Record<NotificationLevel, number>> = {
  critical: 5,
  risk_deny: 4,
  warning: 4,
  budget_alert: 4,
  info: 3,
  session_lifecycle: 2,
  summary: 2,
};

const TAGS: Partial<Record<NotificationLevel, string[]>> = {
  critical: ["rotating_light"],
  risk_deny: ["no_entry"],
  warning: ["warning"],
  budget_alert: ["money_with_wings"],
  summary: ["memo"],
};

export class NtfyChannel implements NotificationChannel {
  readonly id = "ntfy" as const;
  private readonly fetchImpl: HttpFetch;
  private readonly timeoutMs: number;
  private counter = 0;

  constructor(private readonly opts: NtfyChannelOptions) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async isReady(): Promise<boolean> {
    return /^https?:\/\//.test(this.opts.server) && this.opts.topic.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    await this.publish({
      title: clipText(n.title, 200),
      message: [clipText(n.body, 3_500), decisionHint(n)].filter(Boolean).join("\n\n"),
      priority: PRIORITY[n.level] ?? 3,
      tags: TAGS[n.level] ?? [],
    });
    this.counter += 1;
    return { channelMessageId: `ntfy-${this.counter}` };
  }

  async updateMessage(_ref: ChannelMessageRef, body: string): Promise<void> {
    // ntfy messages can't be edited — send a short follow-up.
    await this.publish({ title: "Foreman update", message: clipText(body, 1_000), priority: 2, tags: [] });
  }

  async listen(_onDecision: (d: UserDecision) => Promise<void>): Promise<void> {}

  async shutdown(): Promise<void> {}

  private async publish(msg: { title: string; message: string; priority: number; tags: string[] }): Promise<void> {
    // JSON publishing (POST to the server root) keeps UTF-8 titles intact,
    // unlike the header-based API.
    await postWithTimeout({
      channel: "ntfy",
      fetchImpl: this.fetchImpl,
      url: this.opts.server.replace(/\/+$/, ""),
      headers: {
        "content-type": "application/json",
        ...(this.opts.accessToken ? { authorization: `Bearer ${this.opts.accessToken}` } : {}),
      },
      body: JSON.stringify({ topic: this.opts.topic, ...msg }),
      timeoutMs: this.timeoutMs,
    });
  }
}
