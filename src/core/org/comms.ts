import { existsSync, statSync } from "node:fs";
import { and, desc, gt, inArray, or, eq, sql } from "drizzle-orm";
import { monotonicFactory } from "ulid";
import type { ForemanDb } from "../../db/client.js";
import { orgMessages, type OrgMessage } from "../../db/schema.js";
import type { EventBus, ForemanEventMap } from "../event-bus.js";
import { stripControl } from "../inbox.js";
import { redactSecretShapes } from "../risk-rules/secret-patterns.js";
import { checkRolePair, HUMAN, isHead, loadOrg, rolesForAgent, type OrgDoc } from "./org.js";

// =============================================================================
// Department channels (#630) — agents talk to each other through Foreman
// =============================================================================
//
// Channels:
//   dept:<id>      a department's room
//   leadership     department heads and the roles that report to you
//   all            all-hands
//   boss           messages to you (reports, questions)
//   dm:<a>|<b>     a thread between two roles (or a role and you)
//
// Posting follows org.yaml, like delegation: an agent can reach its own
// department, its manager and its reports; other departments only through
// the heads (per `delegation.cross_department`); anyone in the org can
// post to all-hands and to you. You can post anywhere and read everything.
//
// Every message is stored locally (secrets redacted, control characters
// stripped, clipped) and mirrored to Slack / Discord by `foreman start`
// when org.yaml maps the channel (comms-mirror.ts). Message text is data:
// nothing in it is ever executed.

export const BOSS = "boss";
export const MAX_MESSAGE = 4_000;

export type MessageKind = OrgMessage["kind"];
/** Kinds an agent (or you) may post. `review` and `recommendation` are
 *  written by Foreman itself (approval escalation, #623), so no agent can
 *  pass a message of its own off as one. */
export const MESSAGE_KINDS: readonly MessageKind[] = ["message", "report", "question", "handoff", "announcement"];
/** Author of messages Foreman writes itself. `foreman` is a human source,
 *  so `foreman mcp-stdio --source foreman` is refused: no agent posts as it. */
export const FOREMAN_AUTHOR = "foreman";

export interface PostInput {
  /** The posting agent's id. Ignored when `asOwner` is set. */
  from: string;
  /** Posted by you. Only owner surfaces (the TUI, the CLI, Slack / Discord
   *  allowed users) set this; an agent id can never mean the owner. */
  asOwner?: boolean;
  /** all · leadership · boss · a department · a role · an agent. */
  to: string;
  text: string;
  kind?: MessageKind;
  replyTo?: string | null;
}

export type PostResult =
  | { ok: true; message: OrgMessage; label: string }
  | { ok: false; reason: string };

const nextId = monotonicFactory();

export class OrgComms {
  private org: { doc: OrgDoc | null; mtimeMs: number } | null = null;

  constructor(
    private readonly db: ForemanDb,
    private readonly opts: { orgConfigPath: string; bus?: EventBus<ForemanEventMap>; now?: () => number },
  ) {}

  post(input: PostInput): PostResult {
    const text = cleanText(input.text);
    if (!text) return { ok: false, reason: "the message is empty" };
    const org = this.orgDoc();
    const sender = senderOf(org, input.from, input.asOwner === true);
    const target = resolveTarget(org, sender, input.to);
    if ("error" in target) return { ok: false, reason: target.error };
    const verdict = canPost(org, sender, target.channel);
    if (!verdict.allowed) return { ok: false, reason: verdict.reason };
    const ts = (this.opts.now ?? Date.now)();
    const message: OrgMessage = {
      id: nextId(ts),
      ts,
      channel: target.channel,
      fromAgent: sender.agent,
      fromRole: sender.roles[0] ?? null,
      kind: input.kind && MESSAGE_KINDS.includes(input.kind) ? input.kind : "message",
      text,
      replyTo: input.replyTo?.slice(0, 32) ?? null,
      mirroredAt: null,
    };
    this.db.insert(orgMessages).values(message).run();
    this.opts.bus?.emit("org:message", { message });
    return { ok: true, message, label: channelLabel(target.channel) };
  }

  /** A message Foreman writes on a channel itself (approval escalation,
   *  #623). No chart check: callers decide the channel and the author.
   *  The text is cleaned like any other message. */
  record(input: {
    channel: string;
    fromAgent: string;
    fromRole: string | null;
    kind: MessageKind;
    text: string;
    replyTo?: string | null;
  }): OrgMessage | null {
    const text = cleanText(input.text);
    if (!text) return null;
    const ts = (this.opts.now ?? Date.now)();
    const message: OrgMessage = {
      id: nextId(ts),
      ts,
      channel: input.channel,
      fromAgent: input.fromAgent,
      fromRole: input.fromRole,
      kind: input.kind,
      text,
      replyTo: input.replyTo?.slice(0, 32) ?? null,
      mirroredAt: null,
    };
    this.db.insert(orgMessages).values(message).run();
    this.opts.bus?.emit("org:message", { message });
    return message;
  }

  /** Report up the chain: to the sender's manager, or to you when the
   *  sender reports to you (or isn't in the org). */
  report(from: string, text: string): PostResult {
    const org = this.orgDoc();
    const sender = senderOf(org, from, false);
    const role = sender.roles[0];
    const manager = role && org ? org.roles[role]?.reports_to : undefined;
    const to = !manager || manager === HUMAN ? BOSS : manager;
    return this.post({ from, to, text, kind: "report" });
  }

  /** Messages `viewer` may see, newest last. `channel` narrows to one
   *  channel (same words as `to`). */
  read(opts: { viewer: string; asOwner?: boolean; channel?: string; since?: number; limit?: number }): OrgMessage[] {
    const org = this.orgDoc();
    const viewer = senderOf(org, opts.viewer, opts.asOwner === true);
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
    let scope;
    if (opts.channel) {
      const filter = readFilter(org, viewer, opts.channel);
      if ("error" in filter) return [];
      scope = filter.scope;
    } else if (!viewer.isBoss) {
      const own = eq(orgMessages.fromAgent, viewer.agent);
      const visible = visibleChannels(org, viewer);
      // Exact thread membership: role ids can't contain LIKE wildcards or `|`.
      const dms = viewer.roles.flatMap((r) => [
        sql`${orgMessages.channel} LIKE ${`dm:${r}|%`}`,
        sql`${orgMessages.channel} LIKE ${`dm:%|${r}`}`,
      ]);
      scope = or(own, visible.length > 0 ? inArray(orgMessages.channel, visible) : undefined, ...dms);
    }
    const rows = this.db
      .select()
      .from(orgMessages)
      .where(and(scope, opts.since ? gt(orgMessages.ts, opts.since) : undefined))
      .orderBy(desc(orgMessages.ts), desc(orgMessages.id))
      .limit(limit)
      .all();
    return rows.reverse();
  }

  /** Why `channel` can't be read by this viewer (unknown, not theirs), or
   *  null. Callers say so instead of printing "No messages yet" (#657). */
  readError(opts: { viewer: string; asOwner?: boolean; channel: string }): string | null {
    const org = this.orgDoc();
    const filter = readFilter(org, senderOf(org, opts.viewer, opts.asOwner === true), opts.channel);
    return "error" in filter ? filter.error : null;
  }

  orgDoc(): OrgDoc | null {
    const path = this.opts.orgConfigPath;
    if (!existsSync(path)) return null;
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (!this.org || this.org.mtimeMs !== mtimeMs) this.org = { doc: loadOrg(path), mtimeMs };
      return this.org.doc;
    } catch {
      return null;
    }
  }
}

/** The registry, as far as the org tools need it. */
export interface AgentRoster {
  listAll(): ReadonlyArray<{ id: string; status: string }>;
}

/** Why none of `ids` may speak for the org right now, or null. Ids compare
 *  the way the chart does (trimmed, lowercase), so `--source Claude-Code`
 *  is as blocked as `claude-code`: a blocked or disabled registration of
 *  any spelling silences them all. */
export function silencedReason(roster: AgentRoster, ...ids: string[]): string | null {
  const wanted = new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean));
  for (const agent of roster.listAll()) {
    if (!wanted.has(agent.id.trim().toLowerCase())) continue;
    if (agent.status === "blocked" || agent.status === "disabled") {
      return `${agent.id} is ${agent.status} in Foreman`;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Rules
// -----------------------------------------------------------------------------

export interface Sender {
  agent: string;
  roles: string[];
  isBoss: boolean;
}

export function senderOf(org: OrgDoc | null, from: string, asOwner = false): Sender {
  if (asOwner) return { agent: BOSS, roles: [], isBoss: true };
  const id = from.trim().toLowerCase();
  return { agent: id, roles: org ? rolesForAgent(org, id) : [], isBoss: false };
}



const ALIASES: Record<string, string> = {
  all: "all",
  "all-hands": "all",
  allhands: "all",
  everyone: "all",
  company: "all",
  leadership: "leadership",
  heads: "leadership",
  boss: BOSS,
  human: BOSS,
  owner: BOSS,
  you: BOSS,
  me: BOSS,
};

/** What the sender typed as `to` → a channel key. */
export function resolveTarget(org: OrgDoc | null, sender: Sender, to: string): { channel: string } | { error: string } {
  const word = to.trim().toLowerCase().replace(/^[#@]/, "");
  if (!word) return { error: "say who the message is for (a department, a role, all, leadership or boss)" };
  if (word.startsWith("dept:") || word.startsWith("dm:")) return { channel: word };
  const alias = ALIASES[word];
  if (alias) return { channel: alias === BOSS && sender.isBoss ? "all" : alias };
  if (!org) return { error: "department and role channels need an org chart — run `foreman org init`" };
  if (Object.hasOwn(org.departments, word)) return { channel: `dept:${word}` };
  const role = Object.hasOwn(org.roles, word) ? word : rolesForAgent(org, word)[0];
  if (role) {
    const me = sender.isBoss ? BOSS : sender.roles[0];
    if (!me) return { error: "you are not in the org chart, so you can only write to boss" };
    if (me === role) return { error: "that's you" };
    return { channel: dmChannel(me, role) };
  }
  const known = [...Object.keys(org.departments), ...Object.keys(org.roles)].slice(0, 12).join(", ");
  return { error: `no department, role or agent called '${to}' (try: all, leadership, boss, ${known})` };
}

type ReadScope = ReturnType<typeof eq> | ReturnType<typeof or>;

/** Which messages a `channel` filter selects for `viewer` (#657). Reading
 *  differs from posting in two places, both for you: `boss` (you, me) is
 *  your inbox — reports to you and your direct threads — not all-hands,
 *  where a post to "boss" from you goes; and a role is everything in that
 *  role's direct threads plus what it posted, not only your thread with
 *  it. An agent reading a role sees its own thread with that role. */
function readFilter(org: OrgDoc | null, viewer: Sender, channel: string): { scope: ReadScope } | { error: string } {
  const word = channel.trim().toLowerCase().replace(/^[#@]/, "");
  const inThreadOf = (role: string) => [
    sql`${orgMessages.channel} LIKE ${`dm:${role}|%`}`,
    sql`${orgMessages.channel} LIKE ${`dm:%|${role}`}`,
  ];
  if (viewer.isBoss) {
    if (ALIASES[word] === BOSS) return { scope: or(eq(orgMessages.channel, BOSS), ...inThreadOf(BOSS))! };
    const role = org && Object.hasOwn(org.roles, word) ? word : org ? rolesForAgent(org, word)[0] : undefined;
    if (role && !(org && Object.hasOwn(org.departments, word))) {
      return { scope: or(eq(orgMessages.fromRole, role), ...inThreadOf(role))! };
    }
  }
  const target = resolveTarget(org, viewer, channel);
  if ("error" in target) return target;
  if (!canRead(org, viewer, target.channel)) return { error: `you can't read ${channelLabel(target.channel, viewer.isBoss)}` };
  return { scope: eq(orgMessages.channel, target.channel) };
}

export function dmChannel(a: string, b: string): string {
  return `dm:${[a, b].sort().join("|")}`;
}

function dmMembers(channel: string): string[] {
  return channel.startsWith("dm:") ? channel.slice(3).split("|") : [];
}

export function canPost(org: OrgDoc | null, sender: Sender, channel: string): { allowed: boolean; reason: string } {
  if (sender.isBoss) return { allowed: true, reason: "you" };
  if (channel === BOSS) return { allowed: true, reason: "anyone can report to you" };
  if (!org || sender.roles.length === 0) {
    return { allowed: false, reason: `${sender.agent} is not in the org chart, so it can only write to boss` };
  }
  if (channel === "all") return { allowed: true, reason: "all-hands" };
  if (channel === "leadership") {
    const ok = sender.roles.some((r) => isHead(org, r) || org.roles[r]?.reports_to === HUMAN);
    return ok
      ? { allowed: true, reason: "leadership" }
      : { allowed: false, reason: "only department heads and the roles that report to you post in leadership" };
  }
  if (channel.startsWith("dept:")) {
    const dept = channel.slice(5);
    if (!Object.hasOwn(org.departments, dept)) return { allowed: false, reason: `no department '${dept}'` };
    if (sender.roles.some((r) => org.roles[r]?.department === dept)) return { allowed: true, reason: "own department" };
    switch (org.delegation.cross_department) {
      case "allow":
        return { allowed: true, reason: "cross-department allowed by org.yaml" };
      case "via_heads":
        return sender.roles.some((r) => isHead(org, r))
          ? { allowed: true, reason: "department heads talk across departments" }
          : { allowed: false, reason: `write to your department head, who can take it to ${dept}` };
      case "deny":
        return { allowed: false, reason: "departments are isolated in org.yaml" };
    }
  }
  const members = dmMembers(channel);
  if (members.length === 2) {
    const mine = sender.roles.find((r) => members.includes(r));
    if (!mine) return { allowed: false, reason: "you are not part of that thread" };
    const other = members.find((m) => m !== mine)!;
    if (other === BOSS) return { allowed: true, reason: "to you" };
    if (!Object.hasOwn(org.roles, other)) return { allowed: false, reason: `no role '${other}'` };
    const verdict = checkRolePair(org, mine, other);
    return verdict.allowed
      ? verdict
      : { allowed: false, reason: `${verdict.reason}; write to your manager or a department head instead` };
  }
  return { allowed: false, reason: `unknown channel '${channel}'` };
}

function visibleChannels(org: OrgDoc | null, viewer: Sender): string[] {
  if (!org || viewer.roles.length === 0) return [];
  const channels = new Set<string>(["all"]);
  for (const r of viewer.roles) {
    const dept = org.roles[r]?.department;
    if (dept) channels.add(`dept:${dept}`);
    if (isHead(org, r) || org.roles[r]?.reports_to === HUMAN) channels.add("leadership");
  }
  return [...channels];
}

export function canRead(org: OrgDoc | null, viewer: Sender, channel: string): boolean {
  if (viewer.isBoss) return true;
  if (visibleChannels(org, viewer).includes(channel)) return true;
  const members = dmMembers(channel);
  return members.length === 2 && viewer.roles.some((r) => members.includes(r));
}

/** How a channel reads to whoever is looking: "you" for the owner, "boss"
 *  when an agent is reading. */
export function channelLabel(channel: string, forOwner = true): string {
  const owner = forOwner ? "you" : "boss";
  if (channel === "all") return "#all-hands";
  if (channel === "leadership") return "#leadership";
  if (channel === BOSS) return `→ ${owner}`;
  if (channel.startsWith("dept:")) return `#${channel.slice(5)}`;
  const members = dmMembers(channel).map((m) => (m === BOSS ? owner : m));
  return members.length === 2 ? `${members[0]} ↔ ${members[1]}` : channel;
}

/** Message text as it is stored: control characters stripped, secrets
 *  redacted, clipped to `max`. */
export function cleanText(text: string, max: number = MAX_MESSAGE): string {
  const redacted = redactSecretShapes(stripControl(text.replace(/\r\n?/g, "\n"))).text.trim();
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/** One header line per message, then its text indented, so a message can
 *  never pass off a line of its own as another message. `forOwner` false
 *  renders for an agent (the owner is "boss"). */
export function renderMessages(messages: OrgMessage[], now: number = Date.now(), forOwner = true): string {
  if (messages.length === 0) return "No messages yet.";
  const owner = forOwner ? "you" : "boss";
  return messages
    .map((m) => {
      const who = m.fromAgent === BOSS ? owner : m.fromRole ? `${m.fromRole} (${m.fromAgent})` : m.fromAgent;
      const kind = m.kind === "message" ? "" : ` [${m.kind}]`;
      const body = m.text.split("\n").join("\n    ");
      return `${ago(now - m.ts)} · ${channelLabel(m.channel, forOwner)} · ${who}${kind}: ${body}`;
    })
    .join("\n");
}

function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
