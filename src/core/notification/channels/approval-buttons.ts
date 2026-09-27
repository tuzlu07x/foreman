import { timingSafeEqual } from "node:crypto";
import { formatApprovalToken, parseApprovalToken } from "../../approval-token.js";
import { intentForActionId, type ChannelAction, type Notification, type UserDecision } from "../types.js";

// =============================================================================
// Approval buttons for channels that Foreman listens to itself
// =============================================================================
//
// The Telegram approval bot, Slack Socket Mode and the Discord Gateway all
// deliver a button press straight to Foreman over a connection that only
// Foreman holds. Each button carries `fa:<action>:<approvalId>.<tag>`,
// where the tag is the HMAC from approval-token.ts bound to that approval
// AND that action. A payload can only come from a button Foreman rendered,
// and a tap on "deny" can never be replayed as "allow".

export const APPROVAL_BUTTON_ACTIONS = ["allow", "deny", "allow_always", "deny_always"] as const;
export type ApprovalButtonAction = (typeof APPROVAL_BUTTON_ACTIONS)[number];

export type ApprovalSigner = (approvalId: string, actionId: string) => string;

const BUTTON_RE = /^fa:([a-z_]+):(.+)$/;

export function isApprovalButtonAction(id: string): id is ApprovalButtonAction {
  return (APPROVAL_BUTTON_ACTIONS as readonly string[]).includes(id);
}

/** The approval buttons for a notification, in its own order. Empty when
 *  it is not an approval prompt. Custom actions (block_<rule>, …) are left
 *  out: they need the relay path. */
export function approvalButtons(n: Notification): Array<ChannelAction & { id: ApprovalButtonAction }> {
  if (!n.requestId) return [];
  return n.actions.filter((a): a is ChannelAction & { id: ApprovalButtonAction } => isApprovalButtonAction(a.id));
}

export function encodeApprovalButton(approvalId: string, action: ApprovalButtonAction, sign: ApprovalSigner): string {
  return `fa:${action}:${formatApprovalToken(approvalId, sign(approvalId, action))}`;
}

export type ButtonCheck =
  | { ok: true; requestId: string; decision: ApprovalButtonAction }
  | { ok: false; reason: "unsupported" | "invalid" };

/** Verify a button payload. Constant-time tag comparison. */
export function verifyApprovalButton(payload: string, sign: ApprovalSigner | undefined): ButtonCheck {
  const match = BUTTON_RE.exec(payload);
  const action = match?.[1];
  if (!match || !action || !isApprovalButtonAction(action)) return { ok: false, reason: "unsupported" };
  const { approvalId, tag } = parseApprovalToken(match[2]!);
  if (!sign || !tag || !sameText(sign(approvalId, action), tag)) return { ok: false, reason: "invalid" };
  return { ok: true, requestId: approvalId, decision: action };
}

export function decisionFromButton(
  check: { requestId: string; decision: ApprovalButtonAction },
  who: { channel: "telegram" | "slack" | "discord"; userId: string },
): UserDecision {
  return {
    notificationId: "",
    requestId: check.requestId,
    decision: check.decision,
    decidedBy: `${who.channel}:${who.userId}`,
    decidedAt: Date.now(),
    channel: who.channel,
  };
}

/** "Allowed ✓" / "Denied ✗", with "(always)" for remembered decisions. */
export function decisionLabel(action: ApprovalButtonAction): string {
  const intent = intentForActionId(action);
  const base = intent === "allow" || intent === "remember-allow" ? "Allowed ✓" : "Denied ✗";
  return intent.startsWith("remember") ? `${base} (always)` : base;
}

export function buttonStyle(action: ApprovalButtonAction): "primary" | "danger" | "neutral" {
  if (action === "allow") return "primary";
  if (action === "deny") return "danger";
  return "neutral";
}

export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Exponential backoff with a cap, for the listeners' reconnect loops. */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly minMs: number,
    private readonly maxMs: number,
  ) {}

  next(): number {
    const ms = Math.min(this.maxMs, this.minMs * 2 ** this.attempt);
    this.attempt += 1;
    return ms;
  }

  reset(): void {
    this.attempt = 0;
  }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
