import { isApprovalButtonAction, verifyApprovalButton, type ApprovalSigner } from "./channels/approval-buttons.js";

// =============================================================================
// Refused Slack / Discord interactions → audit log
// =============================================================================
//
// Two-way Slack and Discord refuse a button tap or `/foreman` from anyone
// outside allowed_user_ids. Each refusal is worth an audit entry (someone
// in the workspace tried to decide an approval or command Foreman), but
// anyone in the workspace can send them, so the entries are rate-limited:
//
//   - at most one event per platform user per minute; the next one written
//     for that user carries `suppressed`, the number not written since;
//   - at most GLOBAL_PER_WINDOW events per minute across all users, so a
//     flood from many accounts can't grow the log faster than that either;
//   - at most MAX_TRACKED users remembered (oldest forgotten first).
//
// A refusal past the limits is still refused; only its audit entry is
// skipped. The entry names the platform, the user id and what was tried
// (`button:<action>` with the approval id when the button is genuine;
// `command:<verb>` for a verb Foreman knows, else `command:other`), never
// the message text or the button's tag.

export const REFUSAL_WINDOW_MS = 60_000;
export const GLOBAL_PER_WINDOW = 30;
const MAX_TRACKED = 1_000;
/** A Slack member id or a Discord snowflake. Anything else is recorded as
 *  "invalid" rather than copied into the log. */
const PLATFORM_USER_ID = /^[A-Za-z0-9]{1,40}$/;
const COMMAND_WORD = /^[a-z][a-z0-9_-]{0,31}$/;

export interface InteractionRefusal {
  platform: "slack" | "discord";
  userId: string;
  /** `button:<action>`, `command:<word>` or `interaction`. */
  attempted: string;
  /** The approval a genuine (correctly tagged) button was for. */
  requestId?: string;
}

export type InteractionRefusalSink = (refusal: InteractionRefusal) => void;

export interface InteractionRefusedEvent extends InteractionRefusal {
  /** Refusals by this user that were not written since the last entry. */
  suppressed?: number;
}

/** What a refused button tried, from its value. The approval id is kept
 *  only when the button carries a valid tag (Foreman rendered it). */
export function describeRefusedButton(
  value: string,
  sign: ApprovalSigner | undefined,
): Pick<InteractionRefusal, "attempted" | "requestId"> {
  const action = /^fa:([a-z_]+):/.exec(value)?.[1];
  if (!action || !isApprovalButtonAction(action)) return { attempted: "button:unknown" };
  const check = verifyApprovalButton(value, sign);
  return check.ok
    ? { attempted: `button:${action}`, requestId: check.requestId }
    : { attempted: `button:${action}` };
}

/** What a refused `/foreman …` tried: its first word only. */
export function describeRefusedCommand(text: string): string {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase() || "help";
  return `command:${COMMAND_WORD.test(word) ? word : "other"}`;
}

export function safePlatformUserId(userId: string): string {
  return PLATFORM_USER_ID.test(userId) ? userId : "invalid";
}

export interface RefusalAuditLimiterOptions {
  now?: () => number;
  windowMs?: number;
  globalPerWindow?: number;
  /** Is this a `/foreman` verb Foreman knows? Anything else is written as
   *  `command:other`, so a first word that is really a secret or free text
   *  never reaches the log. Default: nothing is known. */
  isKnownCommand?: (verb: string) => boolean;
}

/** Writes refused interactions through `write`, within the limits above. */
export class RefusalAuditLimiter {
  private readonly users = new Map<string, { windowStart: number; suppressed: number }>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly globalPerWindow: number;
  private readonly isKnownCommand: (verb: string) => boolean;
  private globalWindowStart = Number.NEGATIVE_INFINITY;
  private globalCount = 0;

  constructor(
    private readonly write: (event: InteractionRefusedEvent) => void,
    opts: RefusalAuditLimiterOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? REFUSAL_WINDOW_MS;
    this.globalPerWindow = opts.globalPerWindow ?? GLOBAL_PER_WINDOW;
    this.isKnownCommand = opts.isKnownCommand ?? (() => false);
  }

  /** True when an audit entry was written. */
  record(refusal: InteractionRefusal): boolean {
    const now = this.now();
    const userId = safePlatformUserId(refusal.userId);
    const key = `${refusal.platform}:${userId}`;
    const entry = this.users.get(key);
    if (entry && now - entry.windowStart < this.windowMs) {
      entry.suppressed += 1;
      return false;
    }
    if (now - this.globalWindowStart >= this.windowMs) {
      this.globalWindowStart = now;
      this.globalCount = 0;
    }
    if (this.globalCount >= this.globalPerWindow) {
      // Not written, but counted, so this user's next entry says so.
      this.remember(key, { windowStart: entry?.windowStart ?? Number.NEGATIVE_INFINITY, suppressed: (entry?.suppressed ?? 0) + 1 });
      return false;
    }
    this.globalCount += 1;
    this.remember(key, { windowStart: now, suppressed: 0 });
    const suppressed = entry?.suppressed ?? 0;
    this.write({
      platform: refusal.platform,
      userId,
      attempted: this.safeAttempted(refusal.attempted),
      ...(refusal.requestId ? { requestId: refusal.requestId } : {}),
      ...(suppressed > 0 ? { suppressed } : {}),
    });
    return true;
  }

  private safeAttempted(attempted: string): string {
    const verb = /^command:(.+)$/.exec(attempted)?.[1];
    if (verb === undefined) return attempted;
    return COMMAND_WORD.test(verb) && this.isKnownCommand(verb) ? attempted : "command:other";
  }

  private remember(key: string, value: { windowStart: number; suppressed: number }): void {
    // Re-inserted, so the Map's order is least recently seen first.
    this.users.delete(key);
    this.users.set(key, value);
    if (this.users.size > MAX_TRACKED) {
      const oldest = this.users.keys().next().value;
      if (oldest !== undefined) this.users.delete(oldest);
    }
  }
}
