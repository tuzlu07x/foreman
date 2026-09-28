import { and, asc, eq, isNull } from "drizzle-orm";
import type { ForemanDb } from "../../db/client.js";
import { orgMessages, type OrgMessage } from "../../db/schema.js";
import type { InboxService } from "../inbox.js";
import {
  ChannelDeliveryError,
  clipText,
  defaultFetch,
  postWithTimeout,
  type HttpFetch,
} from "../notification/channels/http-post.js";
import { slackEndpoints, type SlackEndpoints } from "../notification/channels/slack-endpoints.js";
import { BOSS, channelLabel } from "./comms.js";
import { loadOrg, type OrgDoc } from "./org.js";

// =============================================================================
// Mirror department channels to Slack / Discord (#630)
// =============================================================================
//
// `foreman start` runs this worker. It picks up messages any process wrote
// (agents post through their own `foreman mcp-stdio`) and posts each one to
// the chat channels org.yaml maps it to. Only Foreman holds the tokens;
// agents never talk to Slack or Discord directly.
//
// Adapters are small and pluggable: a platform is a name in org.yaml
// (`channels: { slack: "#marketing" }`) plus an OrgMirror here. Messages
// to you also land in the TUI inbox.

export interface MirrorMessage {
  author: string;
  channelLabel: string;
  kind: OrgMessage["kind"];
  text: string;
}

export interface OrgMirror {
  /** Platform key used in org.yaml, e.g. `slack`. */
  platform: string;
  post(target: string, message: MirrorMessage): Promise<void>;
}

export class SlackMirror implements OrgMirror {
  readonly platform = "slack";
  constructor(
    private readonly token: string,
    private readonly fetchImpl: HttpFetch = defaultFetch,
    private readonly endpoints: SlackEndpoints = slackEndpoints(),
  ) {}

  async post(channel: string, m: MirrorMessage): Promise<void> {
    const kind = m.kind === "message" ? "" : ` · ${m.kind}`;
    // The body is quoted, so a message can't fake a header of its own.
    const text = `*${escapeSlack(m.author)}*${kind}\n${quote(escapeSlack(clipText(m.text, 3_500)))}`;
    const res = await postWithTimeout({
      channel: "slack",
      fetchImpl: this.fetchImpl,
      url: `${this.endpoints.api}/chat.postMessage`,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      timeoutMs: 10_000,
    });
    const body = JSON.parse(res) as { ok?: boolean; error?: string };
    if (!body.ok) throw new Error(`slack: ${body.error ?? "unknown error"}`);
  }
}

export class DiscordMirror implements OrgMirror {
  readonly platform = "discord";
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: HttpFetch = defaultFetch,
  ) {}

  async post(channelId: string, m: MirrorMessage): Promise<void> {
    if (!/^\d{5,25}$/.test(channelId)) throw new Error(`discord: '${channelId}' is not a channel id`);
    const kind = m.kind === "message" ? "" : ` · ${m.kind}`;
    await postWithTimeout({
      channel: "discord",
      fetchImpl: this.fetchImpl,
      url: `https://discord.com/api/v10/channels/${channelId}/messages`,
      headers: { authorization: `Bot ${this.botToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        content: clipText(`**${m.author}**${kind}\n${quote(m.text)}`, 1_900),
        // Agent text must never ping anyone.
        allowed_mentions: { parse: [] },
      }),
      timeoutMs: 10_000,
    });
  }
}

export interface CommsMirrorOptions {
  orgConfigPath: string;
  mirrors: ReadonlyMap<string, OrgMirror>;
  inbox?: InboxService;
  intervalMs?: number;
  now?: () => number;
}

/** Messages older than this when Foreman starts are not mirrored late. */
const MAX_AGE_MS = 24 * 3_600_000;
/** Back off this long after a platform says 429. */
const RATE_LIMIT_PAUSE_MS = 10_000;

export class CommsMirrorWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pausedUntil = 0;
  private readonly warned = new Set<string>();

  constructor(
    private readonly db: ForemanDb,
    private readonly opts: CommsMirrorOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 2_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = (this.opts.now ?? Date.now)();
      if (now < this.pausedUntil) return;
      const pending = this.db
        .select()
        .from(orgMessages)
        .where(isNull(orgMessages.mirroredAt))
        .orderBy(asc(orgMessages.ts), asc(orgMessages.id))
        .limit(50)
        .all();
      if (pending.length === 0) return;
      const org = this.org();
      for (const m of pending) {
        // Reports to you always reach the inbox, however late.
        if (m.channel === BOSS) this.toInbox(m);
        // Chat channels only get what is still news. Review requests
        // (#623) stay local: they carry a report's tool arguments, which
        // must not leave the machine.
        const fresh = m.ts > now - MAX_AGE_MS && m.kind !== "review";
        for (const [platform, target] of fresh ? targetsFor(org, m.channel) : []) {
          const mirror = this.opts.mirrors.get(platform);
          if (!mirror) {
            this.warn(`org.yaml maps ${channelLabel(m.channel)} to ${platform}, but ${platform} has no bot token in notify.yaml`);
            continue;
          }
          try {
            await mirror.post(target, {
              author: authorOf(m),
              channelLabel: channelLabel(m.channel),
              kind: m.kind,
              text: m.text,
            });
          } catch (err) {
            const status = err instanceof ChannelDeliveryError ? err.status : 0;
            if (status === 429) {
              // Rate limited: leave this and the rest for a later pass.
              this.pausedUntil = now + RATE_LIMIT_PAUSE_MS;
              return;
            }
            this.warn(
              `Couldn't mirror to ${platform} ${target}${status ? ` (HTTP ${status})` : ""}`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        // Delivered or given up: each message is attempted once.
        this.db.update(orgMessages).set({ mirroredAt: now }).where(and(isNull(orgMessages.mirroredAt), eq(orgMessages.id, m.id))).run();
      }
    } finally {
      this.running = false;
    }
  }

  private toInbox(m: OrgMessage): void {
    this.opts.inbox?.add({
      level: m.kind === "question" ? "warning" : "info",
      kind: "message",
      title: `${authorOf(m)}${m.kind === "message" ? "" : ` · ${m.kind}`}`,
      body: m.text,
      agentId: m.fromAgent,
      dedupeKey: `org-message:${m.id}`,
    });
  }

  /** One inbox warning per distinct problem (the detail can vary). */
  private warn(title: string, detail = ""): void {
    if (this.warned.has(title)) return;
    this.warned.add(title);
    this.opts.inbox?.add({ level: "warning", kind: "system", title, body: detail, dedupeKey: `comms:${title}` });
  }

  private org(): OrgDoc | null {
    try {
      return loadOrg(this.opts.orgConfigPath);
    } catch {
      return null;
    }
  }
}

/** Platform → channel for a message's channel, from org.yaml. */
export function targetsFor(org: OrgDoc | null, channel: string): Array<[string, string]> {
  if (!org) return [];
  let map: Record<string, string> | undefined;
  if (channel.startsWith("dept:")) map = org.departments[channel.slice(5)]?.channels;
  else if (channel === "all") map = org.channels?.all;
  else if (channel === "leadership") map = org.channels?.leadership;
  else if (channel === BOSS) map = org.channels?.boss;
  else if (channel.startsWith("dm:")) map = org.channels?.direct;
  return Object.entries(map ?? {});
}

/** Mirrors for every chat platform with a bot token in notify.yaml. A
 *  webhook can only post to its own channel, so it can't mirror. */
export function mirrorsFromNotifyConfig(
  bots: { slack?: string | null; discord?: string | null },
  fetchImpl?: HttpFetch,
): Map<string, OrgMirror> {
  const mirrors = new Map<string, OrgMirror>();
  if (bots.slack) mirrors.set("slack", new SlackMirror(bots.slack, fetchImpl));
  if (bots.discord) mirrors.set("discord", new DiscordMirror(bots.discord, fetchImpl));
  return mirrors;
}

function authorOf(m: OrgMessage): string {
  if (m.fromAgent === BOSS) return `you → ${channelLabel(m.channel)}`;
  const who = m.fromRole ? `${m.fromRole} (${m.fromAgent})` : m.fromAgent;
  if (m.channel === BOSS) return `${who} → you`;
  return m.channel.startsWith("dm:") ? `${who} → ${channelLabel(m.channel)}` : who;
}

/** Quote every line (`> `), so the body reads as one block under its author. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
