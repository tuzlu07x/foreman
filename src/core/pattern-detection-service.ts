import type { ForemanDb } from "../db/client.js";
import { requests } from "../db/schema.js";
import type { Request } from "../db/schema.js";
import { gte } from "drizzle-orm";
import {
  describePattern,
  detectPatterns,
  type DetectedPattern,
  type DetectorThresholds,
  DEFAULT_THRESHOLDS,
} from "./pattern-detection.js";
import type {
  ForemanVoice,
  ProactiveUrgency,
} from "./notification/foreman-voice.js";

// =============================================================================
// PatternDetectionService — schedules + dispatches pattern alerts (#304)
// =============================================================================
//
// Owns:
//   - the timer that ticks the detector (default every 10 minutes; voice.yaml
//     will make this configurable in #305),
//   - the SQL query that pulls recent rows from the requests table,
//   - the dispatch loop that turns DetectedPattern → ForemanVoice.sendProactive.
//
// Throttling is delegated to ForemanVoice — sending the same pattern type
// twice within its per-type cooldown is a no-op.

export interface PatternDetectionOptions {
  db: ForemanDb;
  voice: ForemanVoice;
  /** Tick interval in ms. Default 10 min. */
  tickMs?: number;
  /** Detector thresholds. Defaults match DEFAULT_THRESHOLDS. */
  thresholds?: DetectorThresholds;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Maximum rows to pull per tick — keeps the query bounded on busy logs. */
  maxRows?: number;
}

const DEFAULT_TICK_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_ROWS = 2000;

// Map pattern kind → ForemanVoice urgency. Repeated-allow is "info" because
// nothing is going wrong; repeated-denial is "warning" because the user is
// clearly seeing something they don't want; burst + off-responsibility lean
// "warning" because both indicate likely-misbehaving agent.
const URGENCY: Record<DetectedPattern["kind"], ProactiveUrgency> = {
  repeated_allow: "info",
  repeated_denial: "warning",
  burst: "warning",
  off_responsibility_cluster: "warning",
};

const VOICE_TYPE: Record<DetectedPattern["kind"], "pattern_detection"> = {
  repeated_allow: "pattern_detection",
  repeated_denial: "pattern_detection",
  burst: "pattern_detection",
  off_responsibility_cluster: "pattern_detection",
};

export class PatternDetectionService {
  private readonly db: ForemanDb;
  private readonly voice: ForemanVoice;
  private readonly tickMs: number;
  private readonly thresholds: DetectorThresholds;
  private readonly now: () => number;
  private readonly maxRows: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PatternDetectionOptions) {
    this.db = opts.db;
    this.voice = opts.voice;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    this.now = opts.now ?? (() => Date.now());
    this.maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  }

  /** Start the periodic tick. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Best-effort — never let a timer tick throw and kill the loop.
      this.tick().catch(() => {});
    }, this.tickMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  /** Stop the timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one detection pass. Exposed so callers can trigger an immediate scan
   * (e.g. right after a request:decided event in tests / under heavy load).
   */
  async tick(): Promise<DetectedPattern[]> {
    const rows = this.loadRecentRows();
    const patterns = detectPatterns(rows, this.now(), this.thresholds);
    for (const p of patterns) {
      const { title, body } = describePattern(p);
      await this.voice.sendProactive({
        type: VOICE_TYPE[p.kind],
        urgency: URGENCY[p.kind],
        title,
        body,
      });
    }
    return patterns;
  }

  private loadRecentRows(): Request[] {
    // Pull a generous window — the detector itself prunes per-window when
    // counting. Bounded by maxRows so the query stays cheap on huge logs.
    const cutoff =
      this.now() - Math.max(this.thresholds.repeatedWindowMs, this.thresholds.burstWindowMs);
    return this.db
      .select()
      .from(requests)
      .where(gte(requests.createdAt, cutoff))
      .limit(this.maxRows)
      .all();
  }
}
