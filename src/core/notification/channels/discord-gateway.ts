import { StaleDecisionError, type UserDecision } from "../types.js";
import {
  Backoff,
  decisionFromButton,
  decisionLabel,
  pause,
  verifyApprovalButton,
  type ApprovalSigner,
} from "./approval-buttons.js";
import { clipText, defaultFetch, postWithTimeout, type HttpFetch } from "./http-post.js";
import type { ChatCommandRunner } from "./slack-socket.js";
import { defaultSocketFactory, messageText, trackSocket, type SocketFactory, type TrackedSocket } from "./socket.js";

// =============================================================================
// Discord Gateway listener (#615)
// =============================================================================
//
// Two-way Discord without a public URL: Foreman keeps a Gateway WebSocket
// open with the bot token and receives INTERACTION_CREATE for
//   - approval buttons (message components) on the messages it posted, and
//   - the `/foreman` application command, which it registers on connect.
// Interactions need no privileged intents, so the bot identifies with
// intents 0. Replies go through the interaction callback, which the
// interaction's own token authorises.
//
// Connection lifecycle: Hello → heartbeat on the given interval (a missed
// ACK means a zombie connection: reconnect) → Identify, or Resume when a
// session exists → READY / RESUMED. Reconnect (op 7) and Invalid Session
// (op 9) are honoured; close codes that mean the token or intents are
// wrong stop the listener with a warning instead of looping.

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_GATEWAY = "wss://gateway.discord.gg";
/** Authentication failed / invalid intents: retrying cannot help. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** The session is gone; identify afresh. */
const NEW_SESSION_CLOSE = new Set([4007, 4009]);
const EPHEMERAL = 64;
const SNOWFLAKE = /^\d{5,25}$/;
const INTERACTION_TOKEN = /^[A-Za-z0-9._-]{10,500}$/;

export interface DiscordGatewayOptions {
  botToken: string;
  /** Discord user ids (snowflakes) that may decide approvals and run commands. */
  allowedUserIds: readonly string[];
  sign?: ApprovalSigner;
  onCommand?: ChatCommandRunner;
  onWarning?: (message: string) => void;
  fetchImpl?: HttpFetch;
  socketFactory?: SocketFactory;
  gatewayUrl?: string;
  backoffMs?: { min: number; max: number };
  /** Heartbeat jitter source (tests pin it). */
  random?: () => number;
  timeoutMs?: number;
  /** How long a close we started may wait for the peer (tests shorten it). */
  closeGraceMs?: number;
}

type Json = Record<string, unknown>;

export class DiscordGatewayListener {
  private readonly allowed: ReadonlySet<string>;
  private readonly fetchImpl: HttpFetch;
  private readonly socketFactory: SocketFactory;
  private readonly abort = new AbortController();
  private readonly timeoutMs: number;
  private current: TrackedSocket | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private acked = true;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private seq: number | null = null;
  private reconnectNow = false;
  private commandRegistered = false;

  constructor(private readonly opts: DiscordGatewayOptions) {
    this.allowed = new Set(opts.allowedUserIds);
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  start(onDecision: (d: UserDecision) => Promise<void>): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run(onDecision);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.stopHeartbeat();
    // 1000 ends the session on Discord's side too.
    this.current?.close(1000, "shutdown");
    await this.loop?.catch(() => undefined);
  }

  private async run(onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    const backoff = new Backoff(this.opts.backoffMs?.min ?? 2_000, this.opts.backoffMs?.max ?? 60_000);
    let offlineWarned = false;
    while (!this.abort.signal.aborted) {
      const resuming = this.sessionId !== null && this.seq !== null;
      const base = resuming && this.resumeUrl ? this.resumeUrl : (this.opts.gatewayUrl ?? DEFAULT_GATEWAY);
      const tracked = trackSocket(
        this.socketFactory(`${base.replace(/\/+$/, "")}/?v=10&encoding=json`),
        this.opts.closeGraceMs,
      );
      this.current = tracked;
      tracked.socket.addEventListener("message", (ev) => {
        // Frames from a socket we already gave up on are ignored.
        if (this.current !== tracked) return;
        const text = messageText(ev);
        if (text === null) return;
        this.onPayload(tracked, text, onDecision, () => {
          backoff.reset();
          offlineWarned = false;
        });
      });
      const { code } = await tracked.closed;
      this.stopHeartbeat();
      this.current = null;
      if (this.abort.signal.aborted) return;
      if (FATAL_CLOSE.has(code)) {
        this.opts.onWarning?.(
          `Discord closed the gateway (code ${code}): check the bot token. Two-way Discord is off until it is fixed.`,
        );
        return;
      }
      if (NEW_SESSION_CLOSE.has(code)) this.forgetSession();
      if (this.reconnectNow) {
        this.reconnectNow = false;
        continue;
      }
      if (!offlineWarned && code === 1006) {
        offlineWarned = true;
        this.opts.onWarning?.("The Discord gateway is unreachable. Foreman keeps retrying.");
      }
      await pause(backoff.next(), this.abort.signal);
    }
  }

  private onPayload(
    tracked: TrackedSocket,
    raw: string,
    onDecision: (d: UserDecision) => Promise<void>,
    onReady: () => void,
  ): void {
    let payload: Json;
    try {
      payload = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    if (typeof payload.s === "number") this.seq = payload.s;
    const d = isObject(payload.d) ? payload.d : null;
    switch (payload.op) {
      case 10: {
        const interval = typeof d?.heartbeat_interval === "number" ? d.heartbeat_interval : 41_250;
        this.startHeartbeat(tracked, interval);
        if (this.sessionId && this.seq !== null) {
          send(tracked, { op: 6, d: { token: this.opts.botToken, session_id: this.sessionId, seq: this.seq } });
        } else {
          send(tracked, {
            op: 2,
            d: {
              token: this.opts.botToken,
              intents: 0,
              properties: { os: process.platform, browser: "foreman", device: "foreman" },
            },
          });
        }
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        send(tracked, { op: 1, d: this.seq });
        return;
      case 7:
        // Discord asks for a reconnect; a non-1000 close keeps the session.
        this.reconnectNow = true;
        tracked.close(4000, "reconnect");
        return;
      case 9:
        if (payload.d !== true) this.forgetSession();
        tracked.close(4000, "invalid session");
        return;
      case 0:
        break;
      default:
        return;
    }
    if (payload.t === "READY" && d) {
      this.sessionId = typeof d.session_id === "string" ? d.session_id : null;
      this.resumeUrl = typeof d.resume_gateway_url === "string" && d.resume_gateway_url.startsWith("wss://")
        ? d.resume_gateway_url
        : null;
      const application = isObject(d.application) ? d.application : null;
      const appId = typeof application?.id === "string" ? application.id : null;
      onReady();
      if (appId) void this.registerCommand(appId);
    } else if (payload.t === "RESUMED") {
      onReady();
    } else if (payload.t === "INTERACTION_CREATE" && d) {
      void this.onInteraction(d, onDecision).catch(() => undefined);
    }
  }

  private startHeartbeat(tracked: TrackedSocket, interval: number): void {
    this.stopHeartbeat();
    this.acked = true;
    const beat = (): void => {
      if (!this.acked) {
        // No ACK since the last beat: the connection is a zombie.
        this.stopHeartbeat();
        this.reconnectNow = true;
        tracked.close(4000, "heartbeat timeout");
        return;
      }
      this.acked = false;
      send(tracked, { op: 1, d: this.seq });
    };
    const first = setTimeout(() => {
      beat();
      this.heartbeat = setInterval(beat, interval);
      this.heartbeat.unref?.();
    }, Math.floor(interval * (this.opts.random ?? Math.random)()));
    first.unref?.();
    this.heartbeat = first;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearTimeout(this.heartbeat);
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private forgetSession(): void {
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
  }

  /** Create (or update) the global `/foreman` command. Idempotent. */
  private async registerCommand(appId: string): Promise<void> {
    if (this.commandRegistered || !this.opts.onCommand || !SNOWFLAKE.test(appId)) return;
    this.commandRegistered = true;
    try {
      await postWithTimeout({
        channel: "discord",
        fetchImpl: this.fetchImpl,
        url: `${DISCORD_API}/applications/${appId}/commands`,
        headers: { authorization: `Bot ${this.opts.botToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "foreman",
          type: 1,
          description: "Talk to Foreman: status, org, report, write <agent> <task>…",
          options: [
            {
              type: 3,
              name: "command",
              description: "e.g. status · org · write codex fix the flaky test",
              required: false,
            },
          ],
        }),
        timeoutMs: this.timeoutMs,
      });
    } catch {
      this.commandRegistered = false;
      this.opts.onWarning?.("Couldn't register /foreman on Discord. Approval buttons still work.");
    }
  }

  private async onInteraction(d: Json, onDecision: (dec: UserDecision) => Promise<void>): Promise<void> {
    const id = str(d.id);
    const token = str(d.token);
    if (!SNOWFLAKE.test(id) || !INTERACTION_TOKEN.test(token)) return;
    const member = isObject(d.member) ? d.member : null;
    const user = isObject(member?.user) ? member.user : isObject(d.user) ? d.user : null;
    const userId = str(user?.id);
    const callback = (body: Json): Promise<string> =>
      this.post(`${DISCORD_API}/interactions/${id}/${token}/callback`, body);
    const ephemeral = (content: string): Promise<string> =>
      callback({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

    if (!this.allowed.has(userId)) {
      await ephemeral("You are not allowed to use Foreman here.");
      return;
    }
    const data = isObject(d.data) ? d.data : null;
    if (d.type === 3) {
      const check = verifyApprovalButton(str(data?.custom_id), this.opts.sign);
      if (!check.ok) {
        await ephemeral(check.reason === "invalid" ? "This button is no longer valid." : "Unsupported button.");
        return;
      }
      let outcome = `${decisionLabel(check.decision)} by <@${userId}>`;
      try {
        await onDecision(decisionFromButton(check, { channel: "discord", userId }));
      } catch (err) {
        if (!(err instanceof StaleDecisionError)) {
          // Keep the buttons so the user can try again.
          await ephemeral("Couldn't record that decision. Try again, or decide in the Foreman TUI.");
          return;
        }
        outcome = "This approval is no longer open here (decided, or re-sent after a restart).";
      }
      // UPDATE_MESSAGE: drop the buttons so a second tap can't race the first.
      await callback({
        type: 7,
        data: {
          content: outcome,
          components: [],
          allowed_mentions: { parse: [] },
        },
      });
      return;
    }
    if (d.type === 2 && data?.name === "foreman") {
      if (!this.opts.onCommand) {
        await ephemeral("Commands are not available in this Foreman session.");
        return;
      }
      const options = Array.isArray(data.options) ? data.options.filter(isObject) : [];
      const text = str(options.find((o) => o.name === "command")?.value).trim() || "help";
      // Deferred, private reply: commands can take longer than 3 s.
      await callback({ type: 5, data: { flags: EPHEMERAL } });
      let answer: string;
      try {
        answer = await this.opts.onCommand(text, userId);
      } catch (err) {
        answer = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      const appId = str(d.application_id);
      if (!SNOWFLAKE.test(appId)) return;
      await this.post(
        `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`,
        { content: clipText(`\`/foreman ${text}\`\n${answer}`, 1_900), allowed_mentions: { parse: [] } },
        "PATCH",
      );
    }
  }

  private post(url: string, body: Json, method: "POST" | "PATCH" = "POST"): Promise<string> {
    return postWithTimeout({
      channel: "discord",
      fetchImpl: this.fetchImpl,
      url,
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    }).catch(() => "");
  }
}

function send(tracked: TrackedSocket, payload: Json): void {
  try {
    tracked.socket.send(JSON.stringify(payload));
  } catch {
    // The close handler reconnects.
  }
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
