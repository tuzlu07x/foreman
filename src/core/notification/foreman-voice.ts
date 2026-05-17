import {
  type EventBus,
  type ForemanEventMap,
  type Unsubscribe,
} from "../event-bus.js";
import type {
  NotificationAction,
  NotificationLevel,
} from "./types.js";
import type { NotificationService } from "./notification-service.js";

// =============================================================================
// ForemanVoice v1 (#303)
// =============================================================================
//
// Today's NotificationService only answers questions ("agent X wants to do Y,
// approve?"). Vision needs Foreman to **speak first**: daily summaries,
// pattern alerts, health updates, budget warnings, suggestions.
//
// This file is the SCAFFOLDING. It owns:
//   - the public `sendProactive()` entry point (throttled, quiet-hours-aware,
//     routes via NotificationService.send to the right channel),
//   - bus subscriptions to `approval:requested`, `request:decided`, etc.
//     where the trigger logic (#304 pattern detection, #306 smart summary,
//     v0.2 #309 agent health) will plug in,
//   - a small `register(handler)` API so each trigger can attach without
//     touching this file.
//
// The actual message *content* lives in those follow-up issues. v0.1.0 ships
// the framework; v0.1.1+ light up specific proactive surfaces.

export type ProactiveType =
  | "daily_summary"
  | "weekly_summary"
  | "pattern_detection"
  | "agent_health"
  | "budget_alert"
  | "agent_suggestion"
  | "cve_notification";

export type ProactiveUrgency = "info" | "warning" | "critical";

export interface ProactiveMessage {
  type: ProactiveType;
  urgency: ProactiveUrgency;
  title: string;
  body: string;
  /** Optional inline-keyboard buttons (#302). Tap → bus → policy update,
   *  same flow approval modal uses. */
  actions?: NotificationAction[];
}

/** Quiet-hours window. When the current time is inside this window,
 *  non-critical messages are dropped (the user is asleep). Critical
 *  always fires regardless. Times are local `HH:MM`. */
export interface QuietHours {
  enabled: boolean;
  from: string; // e.g. "23:00"
  to: string; // e.g. "08:00"
}

/** Per-type throttle window — same alert type can't fire more than once per
 *  N minutes. Stops a runaway pattern-detector from spamming. */
export type ThrottleMs = Partial<Record<ProactiveType, number>>;

export interface ForemanVoiceOptions {
  service: NotificationService;
  bus: EventBus<ForemanEventMap>;
  quietHours?: QuietHours;
  throttleMs?: ThrottleMs;
  /** Injected so tests can pin the clock. Defaults to Date.now. */
  now?: () => Date;
}

const DEFAULT_THROTTLE_MS: Required<ThrottleMs> = {
  daily_summary: 60 * 60 * 1000, // 1h — daily-ish means at most once an hour
  weekly_summary: 24 * 60 * 60 * 1000,
  pattern_detection: 60 * 60 * 1000,
  agent_health: 10 * 60 * 1000,
  budget_alert: 60 * 60 * 1000,
  agent_suggestion: 7 * 24 * 60 * 60 * 1000, // at most once a week
  cve_notification: 24 * 60 * 60 * 1000,
};

const URGENCY_TO_LEVEL: Record<ProactiveUrgency, NotificationLevel> = {
  info: "info",
  warning: "warning",
  critical: "critical",
};

/** Result of a sendProactive call — lets callers / tests assert what
 *  happened without parsing logs. */
export type ProactiveOutcome =
  | { status: "sent"; notificationId: string }
  | { status: "throttled"; cooldownMsRemaining: number }
  | { status: "quiet_hours" }
  | { status: "no_service" };

export class ForemanVoice {
  private readonly service: NotificationService;
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly quietHours: QuietHours;
  private readonly throttleMs: Required<ThrottleMs>;
  private readonly now: () => Date;
  private readonly lastSentAt = new Map<ProactiveType, number>();
  private subscriptions: Unsubscribe[] = [];
  // Trigger handlers registered by follow-up consumers (#304 / #306 / etc).
  // Each handler receives the matching bus event and decides whether to call
  // sendProactive(). Stored per event name so dispose() can clear cleanly.
  private readonly triggers = new Map<
    keyof ForemanEventMap,
    Array<(e: unknown) => void | Promise<void>>
  >();

  constructor(opts: ForemanVoiceOptions) {
    this.service = opts.service;
    this.bus = opts.bus;
    this.quietHours = opts.quietHours ?? { enabled: false, from: "", to: "" };
    this.throttleMs = { ...DEFAULT_THROTTLE_MS, ...(opts.throttleMs ?? {}) };
    this.now = opts.now ?? (() => new Date());
  }

  /** Wire up the bus subscriptions. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      this.bus.on("approval:requested", (e) => this.fanout("approval:requested", e)),
      this.bus.on("request:decided", (e) => this.fanout("request:decided", e)),
      this.bus.on("session:halted", (e) => this.fanout("session:halted", e)),
    );
  }

  /** Drop all subscriptions + trigger handlers. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    this.triggers.clear();
  }

  /**
   * Register a trigger that fires every time the named bus event lands.
   * Used by follow-up PRs (#304 pattern detection, #306 smart summary,
   * v0.2 #309 health daemon) to plug in proactive logic without touching
   * this file.
   */
  registerTrigger<K extends keyof ForemanEventMap>(
    event: K,
    handler: (e: ForemanEventMap[K]) => void | Promise<void>,
  ): void {
    const list = this.triggers.get(event) ?? [];
    list.push(handler as (e: unknown) => void | Promise<void>);
    this.triggers.set(event, list);
  }

  /**
   * Send a proactive message to the user. Respects throttle window + quiet
   * hours (critical always fires). Returns the outcome so tests + telemetry
   * can see why a call did or didn't go through.
   */
  async sendProactive(input: ProactiveMessage): Promise<ProactiveOutcome> {
    if (this.isInQuietHours() && input.urgency !== "critical") {
      return { status: "quiet_hours" };
    }
    const remaining = this.cooldownRemaining(input.type);
    if (remaining > 0) {
      return { status: "throttled", cooldownMsRemaining: remaining };
    }

    const level = URGENCY_TO_LEVEL[input.urgency];
    try {
      const result = await this.service.send(level, {
        requestId: null,
        title: input.title,
        body: input.body,
        actions: input.actions ?? [],
        agentBlocking: false,
      });
      this.lastSentAt.set(input.type, this.now().getTime());
      return { status: "sent", notificationId: result.notificationId };
    } catch {
      // Service-level dispatch errors are persisted as `failed` rows on the
      // notifications table — we don't double-handle here.
      return { status: "no_service" };
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async fanout<K extends keyof ForemanEventMap>(
    event: K,
    e: ForemanEventMap[K],
  ): Promise<void> {
    const handlers = this.triggers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        await h(e);
      } catch {
        // A single trigger throwing must not poison the others.
      }
    }
  }

  private cooldownRemaining(type: ProactiveType): number {
    const last = this.lastSentAt.get(type);
    if (last === undefined) return 0;
    const window = this.throttleMs[type];
    const elapsed = this.now().getTime() - last;
    return Math.max(0, window - elapsed);
  }

  private isInQuietHours(): boolean {
    if (!this.quietHours.enabled) return false;
    const { from, to } = this.quietHours;
    const fromMin = parseHhmm(from);
    const toMin = parseHhmm(to);
    if (fromMin === null || toMin === null) return false;
    const t = this.now();
    const nowMin = t.getHours() * 60 + t.getMinutes();
    // Window may wrap midnight ("23:00" → "08:00"). In that case "inside" is
    // nowMin >= from OR nowMin < to. Otherwise the simple range applies.
    return fromMin <= toMin
      ? nowMin >= fromMin && nowMin < toMin
      : nowMin >= fromMin || nowMin < toMin;
  }
}

function parseHhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
