import { sendMail, type MailMessage, type SmtpOptions } from "../smtp.js";
import type {
  ChannelMessageRef,
  Notification,
  NotificationChannel,
  UserDecision,
} from "../types.js";
import { decisionHint } from "./http-post.js";

// =============================================================================
// Email — alerts and daily digests over SMTP
// =============================================================================
//
// Works with any mailbox that offers SMTP submission (Gmail / Google
// Workspace and iCloud with an app password, Outlook, Fastmail, a company
// relay). Outbound only: email can't carry a trustworthy decision back
// without a public endpoint, so approvals stay in the TUI / Telegram.

export interface EmailChannelOptions {
  smtp: SmtpOptions;
  /** Injected in tests. */
  send?: (opts: SmtpOptions, message: MailMessage) => Promise<void>;
}

export class EmailChannel implements NotificationChannel {
  readonly id = "email" as const;
  private counter = 0;
  private readonly sendImpl: (opts: SmtpOptions, message: MailMessage) => Promise<void>;

  constructor(private readonly opts: EmailChannelOptions) {
    this.sendImpl = opts.send ?? sendMail;
  }

  async isReady(): Promise<boolean> {
    return this.opts.smtp.host.length > 0 && this.opts.smtp.to.length > 0;
  }

  async send(n: Notification): Promise<ChannelMessageRef> {
    const hint = decisionHint(n);
    await this.sendImpl(this.opts.smtp, {
      subject: `[Foreman] ${singleLine(n.title)}`,
      text: [n.body, hint, "—\nSent by Foreman · change routing in notify.yaml"].filter(Boolean).join("\n\n"),
    });
    this.counter += 1;
    return { channelMessageId: `email-${this.counter}` };
  }

  async updateMessage(_ref: ChannelMessageRef, body: string): Promise<void> {
    await this.sendImpl(this.opts.smtp, { subject: "[Foreman] update", text: body });
  }

  async listen(_onDecision: (d: UserDecision) => Promise<void>): Promise<void> {}

  async shutdown(): Promise<void> {}
}

function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").slice(0, 150);
}
