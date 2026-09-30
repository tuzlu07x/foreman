import { claimedAgentOf, displayAgentId, isUntrustedSource } from "../agent-identity.js";
import { stripControl } from "../inbox.js";
import type { NotificationService } from "../notification/notification-service.js";
import { channelConfig, isChannelEnabled, type NotifyConfig } from "../notification/notify-config.js";
import { isAgentMuted, isSilenced, type NotifyState } from "../notification/notify-state.js";
import type { OrgMessage } from "../../db/schema.js";
import { BOSS, MESSAGE_KINDS } from "./comms.js";
import type { OrgDoc } from "./org.js";

// =============================================================================
// Messages to you, on your phone (finding 33)
// =============================================================================
//
// A report, question or message addressed to you (the `boss` channel, or a
// direct thread with you) also goes to every chat channel you get Foreman's
// notifications on: Telegram, Slack and Discord, whichever notify.yaml
// enables. Routes don't apply: a report is for you, not for a risk level.
// CommsMirrorWorker pushes it from `foreman start`, the process that holds
// the tokens, at most once per message; agents' `foreman mcp-stdio` only
// writes the row. Talk between colleagues never reaches your phone, and
// neither do `review` / `recommendation` rows (they carry tool arguments).
//
// Double posts: org.yaml `channels.boss` (or `channels.direct`) may already
// mirror the same message to a Slack / Discord channel. When the mirror
// delivered it to the very channel your notifications go to, that platform
// is skipped here; a mirror to another channel (a #reports room, say) and
// a push to your alerts channel are two different places, so both happen.
// Channels compare by what the configs say (`#foreman` = `foreman`); a
// channel named in one file and given by id in the other counts as two.

/** The chat platforms a message to you is pushed to. */
export const OWNER_CHAT_CHANNELS = ["telegram", "slack", "discord"] as const;
export type OwnerChatChannel = (typeof OWNER_CHAT_CHANNELS)[number];

/** Longest message text in a push. The smallest channel limit wins, so the
 *  pointer to the full text survives everywhere: Slack clips a section at
 *  2 900 characters, Discord an embed at 3 900, Telegram a message at 4 096. */
export const OWNER_NOTICE_MAX = 2_800;
export const FULL_TEXT_HINT = "…(full text: foreman org messages boss)";

export interface OwnerNotice {
  level: "info" | "warning";
  title: string;
  body: string;
}

export interface OwnerNotifier {
  /** Where your Slack / Discord notifications go (notify.yaml `channel` of a
   *  bot), to spot a mirror to the same place. Unknown for a webhook. */
  chatTargets: Partial<Record<"slack" | "discord", string>>;
  /** Push `notice` to your chat channels except `skip`. Never throws. */
  send(notice: OwnerNotice, opts: { fromAgent: string; skip: ReadonlySet<OwnerChatChannel> }): Promise<void>;
}

/** A message for you: on `boss` or in a direct thread with you, not
 *  written by you, and of a kind an agent may post. */
export function isToOwner(m: Pick<OrgMessage, "channel" | "fromAgent" | "kind">): boolean {
  if (m.fromAgent === BOSS) return false;
  if (!MESSAGE_KINDS.includes(m.kind)) return false;
  if (m.channel === BOSS) return true;
  return m.channel.startsWith("dm:") && m.channel.slice(3).split("|").includes(BOSS);
}

const KIND_WORD: Record<string, string> = {
  report: "Report",
  question: "Question",
  handoff: "Handoff",
  announcement: "Announcement",
  message: "Message",
};

/** Who wrote it, for you: the role's title and id, the agent id when it
 *  holds no role, and never a role for an unverified connection. */
export function ownerNoticeAuthor(m: Pick<OrgMessage, "fromAgent" | "fromRole">, org: OrgDoc | null): string {
  if (isUntrustedSource(m.fromAgent)) return `⚠ unverified: ${displayAgentId(claimedAgentOf(m.fromAgent))}`;
  const role = m.fromRole;
  if (!role) return displayAgentId(m.fromAgent);
  const shownRole = displayAgentId(role);
  const title = org && Object.hasOwn(org.roles, role) ? oneLine(org.roles[role]?.title ?? "", 80) : "";
  return title && title.toLowerCase() !== role ? `${title} (${shownRole})` : shownRole;
}

/** The push for a message to you: plain text, short. Channels escape it
 *  for their own markup (Telegram MarkdownV2, Slack mrkdwn). */
export function ownerNotice(m: Pick<OrgMessage, "fromAgent" | "fromRole" | "kind" | "text">, org: OrgDoc | null): OwnerNotice {
  const title = `${KIND_WORD[m.kind] ?? "Message"} from ${ownerNoticeAuthor(m, org)}`;
  const text = clipForOwner(m.text);
  const body = isUntrustedSource(m.fromAgent)
    ? `Sent without a valid agent token: Foreman can't confirm it is ${displayAgentId(claimedAgentOf(m.fromAgent))}.\n\n${text}`
    : text;
  return { level: m.kind === "question" ? "warning" : "info", title, body };
}

/** `text`, or its first OWNER_NOTICE_MAX characters and where to read the rest. */
export function clipForOwner(text: string, max: number = OWNER_NOTICE_MAX): string {
  if (text.length <= max) return text;
  let cut = max;
  // Don't split a surrogate pair (an emoji) in half.
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}\n${FULL_TEXT_HINT}`;
}

/** Whether a mirror target and a notify.yaml channel are the same place. */
export function sameChatChannel(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string | undefined) => (s ?? "").trim().replace(/^#/, "").toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** Where notify.yaml sends your Slack / Discord notifications, when that
 *  is a bot posting to a channel (the same choice channel-factory makes:
 *  a Slack webhook wins, a Discord webhook wins unless two-way is on). */
export function ownerChatTargets(config: NotifyConfig): Partial<Record<"slack" | "discord", string>> {
  const targets: Partial<Record<"slack" | "discord", string>> = {};
  const slack = channelConfig(config, "slack");
  if (slack && !slack.webhook_url_ref && slack.bot_token_ref && slack.channel) targets.slack = slack.channel;
  const discord = channelConfig(config, "discord");
  const discordWebhook = Boolean(discord?.webhook_url_ref) && !discord?.interactive;
  if (discord && !discordWebhook && discord.bot_token_ref && discord.channel) targets.discord = discord.channel;
  return targets;
}

/** The notifier `foreman start` hands the comms mirror: every enabled chat
 *  channel, through the notification service (same tokens, same audit rows
 *  in `notifications`). A silence window (`foreman notify silence`) holds
 *  these pushes like any other non-critical one, and a muted agent's
 *  messages stay in the inbox; an unverified connection is never muted by
 *  the agent id it claims. */
export function ownerNotifier(opts: {
  service: Pick<NotificationService, "sendTo">;
  config: NotifyConfig;
  getState?: () => NotifyState;
}): OwnerNotifier {
  return {
    chatTargets: ownerChatTargets(opts.config),
    async send(notice, { fromAgent, skip }) {
      const state = opts.getState?.();
      if (state && (isSilenced(state) || isAgentMuted(state, fromAgent))) return;
      const channels = OWNER_CHAT_CHANNELS.filter((c) => isChannelEnabled(opts.config, c) && !skip.has(c));
      if (channels.length === 0) return;
      await opts.service
        .sendTo(channels, notice.level, {
          level: notice.level,
          requestId: null,
          title: notice.title,
          body: notice.body,
          actions: [],
          agentBlocking: false,
        })
        .catch(() => undefined);
    },
  };
}

function oneLine(text: string, max: number): string {
  const line = stripControl(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
