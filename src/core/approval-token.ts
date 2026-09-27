import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
// Each button carries `<approvalId>.<tag>` where
// `tag = HMAC(key, approvalId | actionId)`. The key is derived from the
// secret-store master key and never leaves Foreman, and the tag binds the
// specific action. A relayed allow (or policy change) without a valid tag
// is refused, so:
//   - an agent that is not the relay (any other MCP client) cannot approve
//     anything, even with a pending approval's id in hand;
//   - the relay cannot approve before the user interacts with the message.
//
// Limit: the relaying chat agent holds the bot token. When the user taps
// ANY button on the message (or replies to it), Telegram hands the agent
// the whole message, keyboard included, so a compromised relay can then
// submit a different action than the one tapped. Tags are therefore
// defence in depth against the relay itself; approve a chat agent's own
// risky calls in the TUI. For the same reason allow tokens never appear in
// the message text, which a bot can read back without any user action.

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

/** Telegram caps callback_data at 64 bytes; `block_<rule>` ids for long
 *  rule names don't fit next to a signed approval token. The compact form
 *  keeps the `block_` prefix the relay agent keys on and is resolved back
 *  to the risk factor by `matchesBlockActionId`. */
export function compactBlockActionId(actionId: string): string {
  const digest = createHash("sha256").update(actionId).digest("base64url").slice(0, 10);
  return `block_~${digest}`;
}

export function matchesBlockActionId(candidate: string, fullActionId: string): boolean {
  return candidate === fullActionId || candidate === compactBlockActionId(fullActionId);
}
