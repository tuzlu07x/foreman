import { EventEmitter } from "node:events";
import type {
  LlmVerification,
  RiskBucket,
  RiskFactor,
} from "./risk-rules/types.js";
import type { SecurityReport } from "./security-report.js";

/**
 * Payload shapes for every v0.1 event. Adding a new event = add a key
 * here, then every callsite gets type-checked. Loose `string` / `unknown`
 * fields are reserved for fields that genuinely vary (e.g. tool args).
 */
export interface ForemanEventMap {
  "request:received": {
    requestId: string;
    sourceAgent: string;
    targetAgent?: string;
    targetTool?: string;
    args: unknown;
    receivedAt: number;
  };
  "request:decided": {
    requestId: string;
    sourceAgent: string;
    targetAgent?: string;
    targetTool?: string;
    args: unknown;
    decision: "allowed" | "denied";
    decidedBy: string;
    riskScore: number;
    riskReasons: string[];
    riskFactors: RiskFactor[];
    riskBucket: RiskBucket;
    llmVerification: LlmVerification | null;
    /** Three-layer modal payload (#232 / C9). Persisted on the audit row. */
    securityReport: SecurityReport | null;
    result?: unknown;
    durationMs: number;
    createdAt: number;
    decidedAt: number;
    /** Agent-to-agent flow tracking (#301). parentRequestId/sessionId are
     *  set when the caller chained from a previous request; the audit
     *  listener persists them so the log can render trees. */
    parentRequestId?: string;
    sessionId?: string;
  };
  "agent:registered": {
    agentId: string;
    displayName: string;
    transport: "stdio" | "ws" | "wrap";
    registeredAt: number;
  };
  "agent:heartbeat": {
    agentId: string;
    status: "active" | "inactive" | "blocked";
    seenAt: number;
  };
  "policy:changed": {
    ruleId: number;
    sourceAgent: string;
    target: string;
    effect: "allow" | "deny" | "ask";
    createdBy: "user" | "remember-action" | "yaml";
    changedAt: number;
  };
  "session:halted": {
    sessionId: string;
    reason: "turn_limit" | "token_limit" | "manual" | "loop_detection";
    turnCount: number;
    tokenCount: number;
    haltedAt: number;
  };
  /** #523 — Lifecycle pushes so the user gets a live feed of what their
   *  agents are doing without having to call `/foreman activity`. Routed
   *  via the `session_lifecycle` notification route. */
  "session:started": {
    sessionId: string;
    /** Agent ids in the session. */
    participants: string[];
    /** Free-form trigger string — e.g. "user_command:write". */
    trigger: string;
    /** Optional hint from the planner agent when it can predict turn count. */
    estimatedTurns?: number;
    startedAt: number;
  };
  "session:progress": {
    sessionId: string;
    turnCount: number;
    tokenCount: number;
    /** Last ~3 mediator decisions on this session, newest first. */
    recentDecisions: Array<{
      sourceAgent: string;
      targetTool?: string;
      targetAgent?: string;
      decision: "allowed" | "denied" | "asked";
    }>;
    /** Wall-clock ms since the session started. */
    elapsedMs: number;
    emittedAt: number;
  };
  "session:completed": {
    sessionId: string;
    outcome: "success" | "halted" | "abandoned" | "error";
    /** Optional human-readable reason — required for non-success outcomes
     *  so the completion message can explain what happened. */
    reason?: string;
    turnCount: number;
    tokenCount: number;
    /** Sum of `llm_usage.cost_usd` rows tagged with this session. Placeholder
     *  `0` until #530 wires the per-session cost rollup column. */
    costUsd: number;
    durationMs: number;
    completedAt: number;
  };
  "approval:requested": {
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
    /** Three-layer modal payload (#232 / C9). Drives the modal rendering. */
    securityReport: SecurityReport | null;
    sessionId?: string;
  };
  "approval:resolved": {
    requestId: string;
    decision: "allowed" | "denied";
    remember?: "allow" | "deny";
    /** Who resolved — `agent` added in #406 for MCP-routed approvals so
     *  the audit log distinguishes them from direct TUI / timeout paths. */
    resolvedBy: "user" | "timeout" | "agent";
    /** Channel surface that resolved this approval (#302 / #406). "tui"
     *  for the Ink modal, "telegram"/... for direct OOB callbacks (legacy
     *  before #406), "agent_mcp" for the post-#406 path where an agent
     *  relays the user's `/approve <id>` text command through the
     *  `submit_approval` MCP tool. Used by the mediator to build
     *  `decidedBy: user:<via>`. */
    via?:
      | "tui"
      | "telegram"
      | "discord"
      | "slack"
      | "webhook"
      | "agent_mcp";
    /** #406 — When `via === "agent_mcp"`, the agent id that routed the
     *  user's decision (e.g. "hermes" or "openclaw"). Surfaces in the
     *  TUI activity log as `via hermes (agent)` so the operator can see
     *  which agent's chat the user typed `/approve` into. */
    routedBy?: string;
  };
  /** #426 — Primary chat agent switched for a messaging channel.
   *  Fired by `ChatPrimaryService.set/unset`. TUI Settings + CLI
   *  `chat status` listen so the display refreshes without re-querying. */
  "chat-primary:changed": {
    channel: string;
    /** New primary agent id, or null when the row was deleted. */
    agentId: string | null;
    /** Previous primary, or null when no row existed before. */
    previousAgentId: string | null;
    setAt: number;
  };
  "agent:message": {
    agentId: string;
    message: unknown;
    receivedAt: number;
  };
  "agent:disconnected": {
    agentId: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    disconnectedAt: number;
  };
  "agent:removed": {
    agentId: string;
    removedAt: number;
  };
  "agent:key-rotated": {
    agentId: string;
    rotatedAt: number;
  };
  "agent:config-updated": {
    agentId: string;
    llmProvider: string | null;
    responsibilityNote: string | null;
    updatedAt: number;
  };
  "update:available": {
    current: string;
    latest: string;
    source: "cache" | "network";
  };
  "agent-update:available": {
    updates: Array<{
      id: string;
      displayName: string;
      current: string;
      latest: string;
    }>;
  };
  "agent-update:overshoot": {
    warnings: Array<{
      id: string;
      displayName: string;
      installed: string;
      supportedRange: string;
    }>;
  };
  /** Fires once when the LLM budget first crosses the alert threshold, and
   *  once when it crosses 100% (hard stop). Tracked per billing window. */
  "llm:budget-alert": {
    kind: "threshold" | "exhausted";
    spentUsd: number;
    capUsd: number;
    spentPct: number;
    windowStart: number;
    windowEnd: number;
    daysUntilReset: number;
  };
  /** Agent daemon lifecycle (#349). Emitted by AgentDaemonManager so the TUI
   *  Agents page can render ● running / ✗ crashed and #309's health daemon
   *  can react to unexpected exits. */
  "agent:daemon-started": {
    agentId: string;
    pid: number;
    command: string;
    startedAt: number;
  };
  "agent:daemon-stopped": {
    agentId: string;
    pid: number;
    reason: "user" | "shutdown";
    stoppedAt: number;
  };
  "agent:daemon-crashed": {
    agentId: string;
    pid: number;
    exitCode: number;
    stderr: string;
    crashedAt: number;
  };
  "agent:daemon-skipped": {
    agentId: string;
    reason: string;
  };
  /** #498 — control_commands row inserted (write / stop / llm switch / ...).
   *  TUI Activity feed listens so spawn directives appear instantly,
   *  before the drain handler picks them up. The "lie detector" path:
   *  if Hermes claims a routing, this event has to have fired. */
  "control:enqueued": {
    id: number;
    command: string;
    args: string[];
    sourceAgent: string;
    sourceUser?: string | undefined;
    createdAt: number;
  };
  /** #498 — drain handler marked a control_commands row applied. */
  "control:applied": {
    id: number;
    command: string;
    sourceAgent: string;
    durationMs: number;
    appliedAt: number;
  };
  /** #498 — drain handler marked a control_commands row failed/rejected. */
  "control:failed": {
    id: number;
    command: string;
    sourceAgent: string;
    status: "failed" | "rejected";
    error: string;
    failedAt: number;
  };
}

export type ForemanEvent = keyof ForemanEventMap;
export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

/**
 * Thin typed wrapper around `EventEmitter`. `on()` returns an
 * unsubscribe function so callers don't have to keep both the handler
 * reference and the event name around.
 */
export class EventBus<EventMap> {
  private readonly emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof EventMap & string>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): Unsubscribe {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return () => this.off(event, listener);
  }

  once<K extends keyof EventMap & string>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): Unsubscribe {
    this.emitter.once(event, listener as (payload: unknown) => void);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap & string>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): void {
    this.emitter.off(event, listener as (payload: unknown) => void);
  }

  emit<K extends keyof EventMap & string>(
    event: K,
    payload: EventMap[K],
  ): void {
    this.emitter.emit(event, payload);
  }

  listenerCount<K extends keyof EventMap & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners<K extends keyof EventMap & string>(event?: K): void {
    if (event === undefined) this.emitter.removeAllListeners();
    else this.emitter.removeAllListeners(event);
  }
}

/** Default singleton — every service imports `bus` from here. */
export const bus = new EventBus<ForemanEventMap>();
