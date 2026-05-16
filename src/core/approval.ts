import { and, eq, lt } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { pendingApprovals } from "../db/schema.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";
import type {
  LlmVerification,
  RiskBucket,
  RiskFactor,
} from "./risk-rules/types.js";

export interface ApprovalRequest {
  requestId: string;
  sourceAgent: string;
  targetAgent?: string;
  targetTool?: string;
  args: unknown;
  riskScore: number;
  riskReasons: string[];
  riskFactors: RiskFactor[];
  riskBucket: RiskBucket;
  llmVerification: LlmVerification | null;
  /** When set + a `loop` factor fires, the modal exposes `[k] halt session`. */
  sessionId?: string;
  context?: string;
}

export interface ApprovalDecision {
  decision: "allowed" | "denied";
  remember?: "allow" | "deny";
}

export interface ApprovalService {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export class DenyAllApprovalService implements ApprovalService {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return { decision: "denied" };
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export interface ReadlineApprovalOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  timeoutMs?: number;
  bus?: EventBus<ForemanEventMap>;
}

export class ReadlineApprovalService implements ApprovalService {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ReadlineApprovalOptions = {}) {
    this.bus = opts.bus ?? defaultBus;
    this.timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const input = this.opts.input ?? process.stdin;
    const output = this.opts.output ?? process.stdout;
    const useColor = (output as { isTTY?: boolean }).isTTY === true;

    output.write(renderPrompt(req, useColor));
    const reader = new LineReader(input, this.timeoutMs);
    try {
      output.write("> ");
      const first = await reader.nextLine();
      if (first === null) {
        return this.resolve(req, { decision: "denied" }, "timeout");
      }
      const key = first.trim().toLowerCase();
      if (key === "a")
        return this.resolve(req, { decision: "allowed" }, "user");
      if (key === "r") {
        output.write(rememberHint(useColor));
        output.write("> ");
        const second = await reader.nextLine();
        if (second === null) {
          return this.resolve(req, { decision: "denied" }, "timeout");
        }
        const c = second.trim().toLowerCase();
        if (c === "a") {
          return this.resolve(
            req,
            { decision: "allowed", remember: "allow" },
            "user",
          );
        }
        return this.resolve(
          req,
          { decision: "denied", remember: "deny" },
          "user",
        );
      }
      return this.resolve(req, { decision: "denied" }, "user");
    } finally {
      reader.dispose();
    }
  }

  private resolve(
    req: ApprovalRequest,
    decision: ApprovalDecision,
    resolvedBy: "user" | "timeout",
  ): ApprovalDecision {
    this.bus.emit("approval:resolved", {
      requestId: req.requestId,
      decision: decision.decision,
      remember: decision.remember,
      resolvedBy,
    });
    return decision;
  }
}

export interface BusApprovalOptions {
  timeoutMs?: number;
  bus?: EventBus<ForemanEventMap>;
}

export class BusApprovalService implements ApprovalService {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly timeoutMs: number;

  constructor(opts: BusApprovalOptions = {}) {
    this.bus = opts.bus ?? defaultBus;
    this.timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      let settled = false;
      const off = this.bus.on("approval:resolved", (e) => {
        if (e.requestId !== req.requestId) return;
        finish({ decision: e.decision, remember: e.remember });
      });
      const timer = setTimeout(() => {
        finish({ decision: "denied" }, true);
      }, this.timeoutMs);
      const finish = (
        decision: ApprovalDecision,
        fromTimeout = false,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        if (fromTimeout) {
          this.bus.emit("approval:resolved", {
            requestId: req.requestId,
            decision: "denied",
            resolvedBy: "timeout",
          });
        }
        resolve(decision);
      };
    });
  }
}

// Cross-process approval IPC (#117). Writes the pending row to SQLite,
// polls for a resolution decision, then emits the resolved event on the
// local bus. The TUI in `foreman start` is responsible for spotting the
// pending row (via ApprovalBridge) and writing the decision back.
export interface DbApprovalOptions {
  bus?: EventBus<ForemanEventMap>;
  /** Total wait before we time-out the request and auto-deny. */
  timeoutMs?: number;
  /** How often to poll the DB for a resolution. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 200;

export class DbApprovalService implements ApprovalService {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly db: ForemanDb,
    opts: DbApprovalOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus;
    this.timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const requestedAt = Date.now();
    this.db
      .insert(pendingApprovals)
      .values({
        requestId: req.requestId,
        sourceAgent: req.sourceAgent,
        targetAgent: req.targetAgent ?? null,
        targetTool: req.targetTool ?? null,
        args: JSON.stringify(req.args ?? null),
        riskScore: req.riskScore,
        riskReasons: JSON.stringify(req.riskReasons),
        riskFactors: JSON.stringify(req.riskFactors),
        riskBucket: req.riskBucket,
        status: "pending",
        requestedAt,
      })
      .run();

    const deadline = requestedAt + this.timeoutMs;
    while (Date.now() < deadline) {
      const row = this.db
        .select()
        .from(pendingApprovals)
        .where(eq(pendingApprovals.requestId, req.requestId))
        .get();
      if (row && row.status === "resolved") {
        const decision: ApprovalDecision = {
          decision: row.decision ?? "denied",
          ...(row.remember ? { remember: row.remember } : {}),
        };
        this.bus.emit("approval:resolved", {
          requestId: req.requestId,
          decision: decision.decision,
          remember: decision.remember,
          resolvedBy: row.resolvedBy ?? "timeout",
        });
        return decision;
      }
      await sleep(this.pollIntervalMs);
    }

    // Timeout — best-effort mark the row resolved so the TUI poller stops
    // surfacing it. We always deny on timeout (the safe default).
    this.db
      .update(pendingApprovals)
      .set({
        status: "resolved",
        decision: "denied",
        resolvedBy: "timeout",
        resolvedAt: Date.now(),
      })
      .where(
        and(
          eq(pendingApprovals.requestId, req.requestId),
          eq(pendingApprovals.status, "pending"),
        ),
      )
      .run();
    this.bus.emit("approval:resolved", {
      requestId: req.requestId,
      decision: "denied",
      resolvedBy: "timeout",
    });
    return { decision: "denied" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bridges the SQLite pending_approvals table into the `foreman start`
// process's local bus. Run inside the TUI process: it polls for new pending
// rows, emits `approval:requested` so the existing modal UI fires, and
// listens for `approval:resolved` to write the decision back.
export interface ApprovalBridgeOptions {
  bus?: EventBus<ForemanEventMap>;
  pollIntervalMs?: number;
  /** Cap on how old a pending row can be before we auto-deny it (defensive). */
  staleMs?: number;
}

export class ApprovalBridge {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly pollIntervalMs: number;
  private readonly staleMs: number;
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private offResolved: (() => void) | null = null;

  constructor(
    private readonly db: ForemanDb,
    opts: ApprovalBridgeOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.staleMs = opts.staleMs ?? 5 * 60 * 1000;
  }

  start(): void {
    if (this.timer) return;
    this.offResolved = this.bus.on("approval:resolved", (e) => {
      this.db
        .update(pendingApprovals)
        .set({
          status: "resolved",
          decision: e.decision,
          remember: e.remember ?? null,
          resolvedBy: e.resolvedBy,
          resolvedAt: Date.now(),
        })
        .where(
          and(
            eq(pendingApprovals.requestId, e.requestId),
            eq(pendingApprovals.status, "pending"),
          ),
        )
        .run();
      this.seen.delete(e.requestId);
    });
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
    this.poll(); // immediate first pass so the modal pops without a 200ms gap
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.offResolved) {
      this.offResolved();
      this.offResolved = null;
    }
  }

  private poll(): void {
    const rows = this.db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.status, "pending"))
      .all();
    const stale = Date.now() - this.staleMs;
    for (const row of rows) {
      if (row.requestedAt < stale) {
        // Defensive: anything that's been pending for over staleMs gets
        // auto-denied so the table doesn't grow forever.
        this.db
          .update(pendingApprovals)
          .set({
            status: "resolved",
            decision: "denied",
            resolvedBy: "timeout",
            resolvedAt: Date.now(),
          })
          .where(eq(pendingApprovals.requestId, row.requestId))
          .run();
        continue;
      }
      if (this.seen.has(row.requestId)) continue;
      this.seen.add(row.requestId);
      this.bus.emit("approval:requested", {
        requestId: row.requestId,
        sourceAgent: row.sourceAgent,
        targetAgent: row.targetAgent ?? undefined,
        targetTool: row.targetTool ?? undefined,
        args: safeParse(row.args),
        riskScore: row.riskScore,
        riskReasons: safeParseArray(row.riskReasons),
        riskFactors: safeParseFactors(row.riskFactors),
        riskBucket: row.riskBucket ?? "medium",
        llmVerification: null,
      });
    }
    // Forget seen ids that have left the table (resolved + cleared later).
    if (this.seen.size > 100) {
      const live = new Set(rows.map((r) => r.requestId));
      for (const id of this.seen) {
        if (!live.has(id)) this.seen.delete(id);
      }
    }
    void lt;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeParseArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeParseFactors(s: string | null): RiskFactor[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as RiskFactor[]) : [];
  } catch {
    return [];
  }
}

class LineReader {
  private buffer = "";
  private queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private waiterTimer: NodeJS.Timeout | null = null;
  private wasPaused: boolean;
  private onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        if (this.waiterTimer) {
          clearTimeout(this.waiterTimer);
          this.waiterTimer = null;
        }
        resolve(line);
      } else {
        this.queue.push(line);
      }
    }
  };

  constructor(
    private readonly stream: NodeJS.ReadableStream,
    private readonly timeoutMs: number,
  ) {
    this.wasPaused = stream.isPaused?.() ?? false;
    stream.on("data", this.onData);
    stream.resume?.();
  }

  nextLine(): Promise<string | null> {
    const buffered = this.queue.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.waiterTimer = setTimeout(() => {
        this.waiter = null;
        this.waiterTimer = null;
        resolve(null);
      }, this.timeoutMs);
    });
  }

  dispose(): void {
    this.stream.off("data", this.onData);
    if (this.waiterTimer) {
      clearTimeout(this.waiterTimer);
      this.waiterTimer = null;
    }
    if (this.wasPaused) this.stream.pause?.();
  }
}

function envTimeoutMs(): number | undefined {
  const v = process.env.FOREMAN_APPROVAL_TIMEOUT;
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

function renderPrompt(req: ApprovalRequest, useColor: boolean): string {
  const orange = wrap(useColor, "38;2;255;140;66", "0");
  const yellow = wrap(useColor, "38;2;255;197;66", "0");
  const dim = wrap(useColor, "2", "22");
  const bold = wrap(useColor, "1", "22");

  const divider = "═".repeat(60);
  const flow = req.targetAgent
    ? `${orange(req.sourceAgent)} → ${orange(req.targetAgent)}`
    : `${orange(req.sourceAgent)}`;
  const toolLine = req.targetTool
    ? `  ${bold(req.targetTool)}(${renderArgs(req.args)})`
    : "  (no tool specified)";
  const reasons = req.riskReasons.length
    ? req.riskReasons.map((r) => `    ${dim("◆")} ${r}`).join("\n")
    : `    ${dim("(no flagged reasons)")}`;

  return (
    "\n" +
    `${dim(divider)}\n` +
    `   ___\n` +
    `  (o.o)  ${yellow("⚠ Approval Required")}${pad(yellow(`risk: ${req.riskScore}`), 60)}\n` +
    `   \\_/\n` +
    `\n` +
    `  ${flow}\n` +
    `${toolLine}\n` +
    `\n` +
    `  Reasons:\n` +
    `${reasons}\n` +
    `\n` +
    `${dim(divider)}\n` +
    `[${orange("a")}]llow once  [${orange("d")}]eny  [${orange("r")}]emember rule  ${dim("(default deny on timeout)")}\n`
  );
}

function rememberHint(useColor: boolean): string {
  const orange = wrap(useColor, "38;2;255;140;66", "0");
  const dim = wrap(useColor, "2", "22");
  return `${dim("Remember as")}: [${orange("a")}]llways allow  [${orange("d")}]eny always\n`;
}

function renderArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function wrap(useColor: boolean, open: string, close: string) {
  return (text: string): string =>
    useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text;
}

function pad(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, width - visible.length - 16);
  return " ".repeat(padding) + text;
}
