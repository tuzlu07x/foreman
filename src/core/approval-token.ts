import { createHmac, timingSafeEqual } from "node:crypto";

// =============================================================================
// Approval tokens — proof that a relayed decision came from the human
// =============================================================================
//
// Telegram approvals are relayed: Foreman posts the approval with inline
// buttons, the user taps one, and the chat agent (the bot's only
// `getUpdates` consumer) forwards the tap to Foreman via `submit_approval`.
// That agent is often the very one whose call is waiting — so without a
// check it could "approve" its own request by inventing the tap.
//
// Each button / command therefore carries `<approvalId>.<tag>` where
// `tag = HMAC(key, approvalId | actionId)`. The key is derived from the
// secret-store master key and never leaves Foreman. The Bot API does not
// deliver a bot's own messages to `getUpdates`, so the agent only learns a
// tag when the user actually taps (the tap's `callback_data`) or types the
// command — and the tag binds the specific action, so a tap on "Deny"
// cannot be replayed as "Allow".

const TAG_LENGTH = 10;
const SEPARATOR = ".";

export function deriveApprovalKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("foreman/approval-token/v1").digest();
}

export function approvalTag(key: Buffer, approvalId: string, actionId: string): string {
  return createHmac("sha256", key)
    .update(`${approvalId}|${actionId}`)
    .digest("base64url")
    .slice(0, TAG_LENGTH);
}

/** Signer for TelegramChannelOptions.signApproval. */
export function approvalSigner(masterKey: Buffer): (approvalId: string, actionId: string) => string {
  const key = deriveApprovalKey(masterKey);
  return (approvalId, actionId) => approvalTag(key, approvalId, actionId);
}

export function formatApprovalToken(approvalId: string, tag: string): string {
  return `${approvalId}${SEPARATOR}${tag}`;
}

export function parseApprovalToken(token: string): { approvalId: string; tag: string | null } {
  const at = token.lastIndexOf(SEPARATOR);
  if (at <= 0) return { approvalId: token, tag: null };
  return { approvalId: token.slice(0, at), tag: token.slice(at + 1) || null };
}

export function verifyApprovalTag(
  key: Buffer,
  approvalId: string,
  actionId: string,
  tag: string | null,
): boolean {
  if (!tag) return false;
  const expected = Buffer.from(approvalTag(key, approvalId, actionId));
  const given = Buffer.from(tag);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The action id a decision corresponds to on the Telegram keyboard. */
export function actionIdForDecision(
  decision: "allow" | "deny",
  remember: boolean,
  customActionId?: string,
): string {
  if (customActionId) return customActionId;
  if (decision === "allow") return remember ? "allow_always" : "allow";
  return remember ? "deny_always" : "deny";
}
