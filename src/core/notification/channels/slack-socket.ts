import { StaleDecisionError, type UserDecision } from "../types.js";
import {
  Backoff,
  decisionFromButton,
  decisionLabel,
  pause,
  verifyApprovalButton,
  type ApprovalSigner,
} from "./approval-buttons.js";
import { ChannelDeliveryError, clipText, defaultFetch, postWithTimeout, type HttpFetch } from "./http-post.js";
import { slackEndpoints, type SlackEndpoints } from "./slack-endpoints.js";
import {
  describeRefusedButton,
  describeRefusedCommand,
  type InteractionRefusal,
  type InteractionRefusalSink,
} from "../interaction-refusals.js";
import { defaultSocketFactory, messageText, trackSocket, type SocketFactory, type TrackedSocket } from "./socket.js";

// =============================================================================
// Slack Socket Mode listener (#615)
// =============================================================================
//
// Two-way Slack without a public URL. With an app-level token (`xapp-…`)
// Foreman asks Slack for a WebSocket URL (`apps.connections.open`), and
// Slack delivers button presses and `/foreman` slash commands over it.
// Only Foreman holds the app token, so no agent sees these payloads.
//
// Every envelope is acknowledged first (Slack retries unacknowledged ones
// after 3 s), then handled:
//   - block_actions from an approval message: allowed users only, and the
//     button value must carry a valid HMAC tag (approval-buttons.ts);
//   - `/foreman <command>`: allowed users only, run through the same
//     command router as the TUI; the answer is visible only to the caller.
// Replies go through the payload's `response_url`, which Slack signs into
// the payload; anything that is not a hooks.slack.com URL is ignored
// (slack-endpoints.ts has the one test-only exception).

const STALE_TEXT = "This approval is no longer open here (decided, or re-sent after a restart).";
/** Slack answers these when the token itself is wrong: stop retrying. */
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "not_allowed_token_type",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "missing_scope",
]);

export type ChatCommandRunner = (text: string, userId: string) => Promise<string>;

export interface SlackSocketOptions {
  /** App-level token with `connections:write`. */
  appToken: string;
  /** Slack user ids (U…) that may decide approvals and run commands. */
  allowedUserIds: readonly string[];
  sign?: ApprovalSigner;
  onCommand?: ChatCommandRunner;
  onWarning?: (message: string) => void;
  /** Told about each tap or command from a user who is not allowed, for
   *  the audit log (interaction-refusals.ts rate-limits it). */
  onRefused?: InteractionRefusalSink;
  fetchImpl?: HttpFetch;
  socketFactory?: SocketFactory;
  backoffMs?: { min: number; max: number };
  timeoutMs?: number;
  /** How long a close we started may wait for the peer (tests shorten it). */
  closeGraceMs?: number;
  /** Where Slack is (default: slack.com, see slack-endpoints.ts). */
  endpoints?: SlackEndpoints;
}

type Json = Record<string, unknown>;

export class SlackSocketListener {
  private readonly allowed: ReadonlySet<string>;
  private readonly fetchImpl: HttpFetch;
  private readonly socketFactory: SocketFactory;
  private readonly abort = new AbortController();
  private readonly timeoutMs: number;
  private readonly endpoints: SlackEndpoints;
  private current: TrackedSocket | null = null;
  private running = false;
  private refreshRequested = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: SlackSocketOptions) {
    this.allowed = new Set(opts.allowedUserIds);
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.endpoints = opts.endpoints ?? slackEndpoints();
  }

  start(onDecision: (d: UserDecision) => Promise<void>): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run(onDecision);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.current?.close(1000, "shutdown");
    await this.loop?.catch(() => undefined);
  }

  private async run(onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    const backoff = new Backoff(this.opts.backoffMs?.min ?? 2_000, this.opts.backoffMs?.max ?? 60_000);
    let offlineWarned = false;
    while (!this.abort.signal.aborted) {
      let url: string;
      try {
        url = await this.openConnection();
      } catch (err) {
        if (err instanceof SlackAuthError) {
          this.opts.onWarning?.(
            `Slack rejected the app token (${err.code}). Two-way Slack is off until it is fixed: foreman notify slack-interactive`,
          );
          return;
        }
        if (!offlineWarned) {
          offlineWarned = true;
          this.opts.onWarning?.("Slack Socket Mode is unreachable. Foreman keeps retrying.");
        }
        await pause(backoff.next(), this.abort.signal);
        continue;
      }
      // stop() may have run while the URL was being fetched.
      if (this.abort.signal.aborted) return;
      const tracked = trackSocket(this.socketFactory(url), this.opts.closeGraceMs);
      this.current = tracked;
      tracked.socket.addEventListener("message", (ev) => {
        // Frames from a socket we already gave up on are ignored.
        if (this.current !== tracked) return;
        const text = messageText(ev);
        if (text === null) return;
        void this.onEnvelope(tracked, text, onDecision, () => {
          backoff.reset();
          offlineWarned = false;
        });
      });
      await tracked.closed;
      this.current = null;
      if (this.abort.signal.aborted) return;
      // Slack refreshes connections every few hours, announcing it with a
      // `disconnect` envelope: reconnect straight away after those.
      if (this.refreshRequested) {
        this.refreshRequested = false;
        continue;
      }
      await pause(backoff.next(), this.abort.signal);
    }
  }

  private async openConnection(): Promise<string> {
    let text: string;
    try {
      text = await postWithTimeout({
        channel: "slack",
        fetchImpl: this.fetchImpl,
        url: `${this.endpoints.api}/apps.connections.open`,
        headers: {
          authorization: `Bearer ${this.opts.appToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (err instanceof ChannelDeliveryError && err.status === 401) throw new SlackAuthError("invalid_auth");
      throw err;
    }
    let body: Json;
    try {
      body = JSON.parse(text) as Json;
    } catch {
      throw new Error("unparseable apps.connections.open response");
    }
    if (body.ok !== true) {
      const code = typeof body.error === "string" ? body.error : "unknown_error";
      if (AUTH_ERRORS.has(code)) throw new SlackAuthError(code);
      throw new Error(code);
    }
    if (typeof body.url !== "string" || !body.url.startsWith(this.endpoints.socketUrlPrefix)) {
      throw new Error("apps.connections.open returned no socket URL");
    }
    return body.url;
  }

  private async onEnvelope(
    tracked: TrackedSocket,
    raw: string,
    onDecision: (d: UserDecision) => Promise<void>,
    onHello: () => void,
  ): Promise<void> {
    let envelope: Json;
    try {
      envelope = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    if (envelope.type === "hello") {
      onHello();
      return;
    }
    if (envelope.type === "disconnect") {
      this.refreshRequested = true;
      tracked.close(1000, "refresh");
      return;
    }
    // Acknowledge first: Slack redelivers envelopes not acked within 3 s.
    if (typeof envelope.envelope_id === "string") {
      try {
        tracked.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      } catch {
        return; // the socket is going away; Slack will redeliver
      }
    }
    const payload = isObject(envelope.payload) ? envelope.payload : null;
    if (!payload) return;
    try {
      if (envelope.type === "interactive" && payload.type === "block_actions") {
        await this.onBlockActions(payload, onDecision);
      } else if (envelope.type === "slash_commands") {
        await this.onSlashCommand(payload);
      }
    } catch {
      // One bad payload must never stop the listener.
    }
  }

  private async onBlockActions(payload: Json, onDecision: (d: UserDecision) => Promise<void>): Promise<void> {
    const userId = str(isObject(payload.user) ? payload.user.id : undefined);
    const responseUrl = str(payload.response_url);
    const action = Array.isArray(payload.actions) && isObject(payload.actions[0]) ? payload.actions[0] : null;
    if (!this.allowed.has(userId)) {
      this.refused({ platform: "slack", userId, ...describeRefusedButton(str(action?.value), this.opts.sign) });
      await this.respond(responseUrl, ephemeral("You are not allowed to decide Foreman approvals."));
      return;
    }
    const check = verifyApprovalButton(str(action?.value), this.opts.sign);
    if (!check.ok) {
      await this.respond(
        responseUrl,
        ephemeral(check.reason === "invalid" ? "This button is no longer valid." : "Unsupported button."),
      );
      return;
    }
    let outcome = `${decisionLabel(check.decision)} by <@${userId}>`;
    try {
      await onDecision(decisionFromButton(check, { channel: "slack", userId }));
    } catch (err) {
      if (!(err instanceof StaleDecisionError)) {
        // Keep the buttons so the user can try again.
        await this.respond(responseUrl, ephemeral("Couldn't record that decision. Try again, or decide in the Foreman TUI."));
        return;
      }
      outcome = STALE_TEXT;
    }
    // Swap the buttons for the outcome so a second tap can't race the first.
    const message = isObject(payload.message) ? payload.message : null;
    const kept = Array.isArray(message?.blocks)
      ? message.blocks.filter((b) => isObject(b) && b.type !== "actions")
      : [];
    await this.respond(responseUrl, {
      replace_original: true,
      text: outcome,
      blocks: [...kept, { type: "context", elements: [{ type: "mrkdwn", text: outcome }] }],
    });
  }

  private async onSlashCommand(payload: Json): Promise<void> {
    const userId = str(payload.user_id);
    const responseUrl = str(payload.response_url);
    if (!this.allowed.has(userId)) {
      this.refused({ platform: "slack", userId, attempted: describeRefusedCommand(str(payload.text)) });
      await this.respond(responseUrl, ephemeral("You are not allowed to command Foreman."));
      return;
    }
    if (!this.opts.onCommand) {
      await this.respond(responseUrl, ephemeral("Commands are not available in this Foreman session."));
      return;
    }
    const text = str(payload.text).trim() || "help";
    let answer: string;
    try {
      answer = await this.opts.onCommand(text, userId);
    } catch (err) {
      answer = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await this.respond(responseUrl, ephemeral(`\`/foreman ${escapeSlack(clipText(text, 200))}\`\n${escapeSlack(clipText(answer, 3_500))}`));
  }

  /** Report a refusal; a failing sink never changes the refusal. */
  private refused(refusal: InteractionRefusal): void {
    try {
      this.opts.onRefused?.(refusal);
    } catch {
      // best effort
    }
  }

  private async respond(url: string, body: Json): Promise<void> {
    if (!url.startsWith(this.endpoints.replyUrlPrefix)) return;
    await postWithTimeout({
      channel: "slack",
      fetchImpl: this.fetchImpl,
      url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    }).catch(() => undefined);
  }
}

class SlackAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function ephemeral(text: string): Json {
  return { response_type: "ephemeral", replace_original: false, text };
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
