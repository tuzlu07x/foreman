import { and, eq, lt } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { pendingApprovals } from "../db/schema.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";
import { predicateHintForFactor } from "./risk-rules/predicate-hint.js";
import type {
  LlmVerification,
  RiskBucket,
  RiskFactor,
} from "./risk-rules/types.js";
import type { SecurityReport } from "./security-report.js";

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
  /** Three-layer modal payload (#232 / C9). Modal renders directly from this. */
  securityReport: SecurityReport | null;
  /** When set + a `loop` factor fires, the modal exposes `[k] halt session`. */
  sessionId?: string;
  context?: string;
}

export interface ApprovalDecision {
  decision: "allowed" | "denied";
  remember?: "allow" | "deny";
  /** Which user-facing surface resolved this approval (#302 / #406).
   *  Propagates into the mediator's `decidedBy` so the audit log
   *  distinguishes Telegram-resolved approvals from TUI-resolved ones.
   *  `agent_mcp` (added in #406) means the user typed `/approve <id>`
   *  in an agent's chat and the agent relayed it via the
   *  `submit_approval` MCP tool. Undefined for programmatic / timeout
   *  resolutions. */
  via?:
    | "tui"
    | "telegram"
    | "discord"
    | "slack"
    | "webhook"
    | "agent_mcp";
}

export interface SubmitApprovalFromAgentOpts {
  approvalId: string;
  decision: "allow" | "deny";
  /** When true, remember the same source/target/tool combination so future
   *  identical calls auto-resolve without prompting again. */
  remember?: boolean;
  /** The agent id that routed this approval (the `--source` flag the
   *  agent passes to `foreman mcp-stdio`). Surfaces in the audit log so
   *  operators can tell which agent's chat the user replied in. */
  sourceAgent: string;
  /** #526 — Optional custom action id (e.g. `block_secret_path`) tapped
   *  by the user on an inline-keyboard custom button. When set, the
   *  approval service looks up the matching predicate-hint from the
   *  approval row's risk factors + injects a permanent deny rule via
   *  `policyEngine.addPredicateRule()` BEFORE emitting the resolution
   *  event (so the next identical call by the same agent is denied by
   *  the new rule without re-asking). Decision is always coerced to
   *  `deny` for `block_*` actions. */
  actionId?: string;
}

export interface SubmitApprovalResult {
  ok: boolean;
  /** Free-text error message when `ok === false`. Designed to be shown
   *  back to the agent's user (e.g. "approval abc123 not found"). */
  error?: string;
  /** #526 — When a custom `block_*` action injected a predicate rule,
   *  the new rule id is echoed back so the chat reply can confirm
   *  "policy rule #12 added". Undefined for plain allow/deny. */
  policyRuleId?: number;
}

export interface ApprovalService {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** #406 — Agent-routed approval submission. Validates the
   *  approval id exists + is still pending, then emits the
   *  `approval:resolved` bus event so the in-flight `request()` call
   *  unblocks. Implementations that don't support cross-process
   *  resolution (BusApprovalService, DenyAllApprovalService) may
   *  return `{ ok: false, error: "..." }`. */
  submitFromAgent?(
    opts: SubmitApprovalFromAgentOpts,
  ): Promise<SubmitApprovalResult>;
}

export class DenyAllApprovalService implements ApprovalService {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return { decision: "denied" };
  }
}

// QA round 9: 60s was the legacy CLI default (user is at the keyboard,
// answers immediately). With Telegram-routed approvals (#406 +
// DbApprovalService below), the user's phone may be locked, they may be
// in a meeting — 60s lets the request auto-deny before they ever read
// it. CLI flow still uses CLI_DEFAULT_TIMEOUT_MS; DB-backed flow uses
// the longer DB_DEFAULT_TIMEOUT_MS. Both honour FOREMAN_APPROVAL_TIMEOUT.
const CLI_DEFAULT_TIMEOUT_MS = 60_000;
const DB_DEFAULT_TIMEOUT_MS = 600_000; // 10 min
// Kept as the legacy name so non-DB / non-CLI consumers (notification
// service classes below) keep working without case-by-case overrides.
const DEFAULT_TIMEOUT_MS = CLI_DEFAULT_TIMEOUT_MS;

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
        finish({ decision: e.decision, remember: e.remember, via: e.via });
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
  /** #526 — Optional callback that injects a predicate-based deny rule
   *  from a custom approval action (`block_*` button). Set when wiring
   *  Foreman with a policy engine; omit in unit tests that don't
   *  exercise the policy-injection path. Returns the new rule id so
   *  the chat reply can echo it. Synchronous on purpose — the policy
   *  engine writes to the same SQLite handle the approval service uses,
   *  so there's no I/O wait. */
  injectPredicateRule?: (input: ApprovalRuleInjection) => number;
}

/** #526 — Payload the approval service hands to the policy-engine
 *  injector when the user taps a custom `block_*` button. Decoupled
 *  from `AddPredicateRuleInput` so the approval module doesn't import
 *  the policy engine (avoids a circular dep — the wiring layer joins
 *  them in `foreman start`). */
export interface ApprovalRuleInjection {
  approvalId: string;
  sourceAgent: string;
  target: string;
  predicate: {
    pathMatch?: string[];
    toolPattern?: string;
    argContains?: string;
  };
  reason?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 200;

export class DbApprovalService implements ApprovalService {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly injectPredicateRule?: (
    input: ApprovalRuleInjection,
  ) => number;

  constructor(
    private readonly db: ForemanDb,
    opts: DbApprovalOptions = {},
  ) {
    this.bus = opts.bus ?? defaultBus;
    // QA round 9: DB-backed approval is the flow Telegram (and other
    // out-of-band channels) use. Default to DB_DEFAULT_TIMEOUT_MS (10 min)
    // instead of the CLI's 60s — phone unlocked / context-switched users
    // need real time to react. FOREMAN_APPROVAL_TIMEOUT env still wins.
    this.timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DB_DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.injectPredicateRule = opts.injectPredicateRule;
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

  // #406 — Agent-routed approval submission. Called from the
  // `submit_approval` MCP tool when an agent (Hermes / OpenClaw / …)
  // sees a `/approve <id>` or `/deny <id>` slash command in user chat
  // and relays the decision. Validates the row + emits the bus event;
  // ApprovalBridge then writes the resolution to SQLite which the
  // in-flight `request()` polling picks up to unblock the original
  // mediator call.
  async submitFromAgent(
    opts: SubmitApprovalFromAgentOpts,
  ): Promise<SubmitApprovalResult> {
    // Pull the full row when an actionId is set so the custom-action
    // path can re-derive the predicate from the persisted riskFactors.
    // For the plain allow/deny case, the smaller status-only query
    // keeps the hot path narrow.
    const fullRow = opts.actionId
      ? this.db
          .select()
          .from(pendingApprovals)
          .where(eq(pendingApprovals.requestId, opts.approvalId))
          .get()
      : null;
    const row = fullRow ?? this.db
      .select({
        status: pendingApprovals.status,
      })
      .from(pendingApprovals)
      .where(eq(pendingApprovals.requestId, opts.approvalId))
      .get();
    if (!row) {
      return { ok: false, error: `approval ${opts.approvalId} not found` };
    }
    if (row.status !== "pending") {
      return {
        ok: false,
        error: `approval ${opts.approvalId} already ${row.status}`,
      };
    }

    // #526 — Custom action path: look up the predicate from the risk
    // factors persisted on the approval row, inject the deny rule, and
    // coerce the decision to "deny" regardless of what the agent sent
    // (a `block_*` action always implies block-and-deny).
    let policyRuleId: number | undefined;
    let effectiveDecision: "allow" | "deny" = opts.decision;
    if (opts.actionId && fullRow) {
      if (!this.injectPredicateRule) {
        return {
          ok: false,
          error:
            "policy injection not wired in this Foreman build (#526 — restart with the injector configured)",
        };
      }
      const proposal = resolveProposalFromRow(opts.actionId, fullRow);
      if (!proposal) {
        return {
          ok: false,
          error: `unknown action_id "${opts.actionId}" for approval ${opts.approvalId} (no matching risk factor)`,
        };
      }
      try {
        policyRuleId = this.injectPredicateRule(proposal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `policy injection failed: ${message}`,
        };
      }
      effectiveDecision = "deny";
    }

    const decisionStr: "allowed" | "denied" =
      effectiveDecision === "allow" ? "allowed" : "denied";
    const rememberValue: "allow" | "deny" | undefined = opts.remember
      ? effectiveDecision
      : undefined;
    this.bus.emit("approval:resolved", {
      requestId: opts.approvalId,
      decision: decisionStr,
      remember: rememberValue,
      resolvedBy: "agent",
      via: "agent_mcp",
      routedBy: opts.sourceAgent,
    });
    return { ok: true, ...(policyRuleId ? { policyRuleId } : {}) };
  }
}

/** #526 — Re-derive the predicate proposal for a custom `block_*`
 *  action from the approval row's persisted riskFactors + args. The
 *  callback_data round-trips only the action id (Telegram 64-byte cap);
 *  the actual predicate is rebuilt here so the agent never needs to
 *  understand policy schema. */
function resolveProposalFromRow(
  actionId: string,
  row: typeof pendingApprovals.$inferSelect,
): ApprovalRuleInjection | null {
  if (!actionId.startsWith("block_")) return null;
  const factorRule = actionId.slice("block_".length);
  if (!factorRule) return null;
  let factors: RiskFactor[] = [];
  try {
    factors = row.riskFactors
      ? (JSON.parse(row.riskFactors) as RiskFactor[])
      : [];
  } catch {
    factors = [];
  }
  const matched = factors.find((f) => f.rule === factorRule);
  if (!matched) return null;
  let args: unknown = null;
  try {
    args = row.args ? JSON.parse(row.args) : null;
  } catch {
    args = null;
  }
  const proposal = predicateHintForFactor(matched, args, row.sourceAgent);
  if (!proposal) return null;
  if (proposal.actionId !== actionId) return null;
  if (!row.targetTool) return null;
  return {
    approvalId: row.requestId,
    sourceAgent: row.sourceAgent,
    target: `tool:${row.targetTool}`,
    predicate: proposal.predicate,
    reason: proposal.reason,
  };
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
        securityReport: null,
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
