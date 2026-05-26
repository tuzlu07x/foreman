import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  publicKey: blob("public_key", { mode: "buffer" }).notNull(),
  transport: text("transport", { enum: ["stdio", "ws", "wrap"] }).notNull(),
  endpoint: text("endpoint"),
  registeredAt: integer("registered_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
  status: text("status", {
    enum: ["active", "inactive", "blocked", "disabled"],
  })
    .notNull()
    .default("active"),
  metadata: text("metadata"),
  llmProvider: text("llm_provider"),
  // #408 / #412 — Provider variant id within `llmProvider` (e.g. "via-openrouter"
  // for Hermes/openai, "oauth" for Codex/openai, "native" for OpenClaw/openai).
  // NULL falls back to the registry's `provider_mapping[llmProvider].preferred`.
  providerVariant: text("provider_variant"),
  // #434 — Specific model id chosen per-agent (e.g. claude-opus-4-7 for
  // Hermes, claude-haiku-4-5 for OpenClaw). NULL means the projector
  // uses the variant's default model from registry/agents.json.
  modelVersion: text("model_version"),
  responsibilityNote: text("responsibility_note"),
  // #517 Faz 3 — operator opts out of the agent's shell-tool allowlist
  // gate (e.g. `claude --dangerously-skip-permissions`) and accepts
  // Foreman's MCP-level mediation as the only security boundary.
  // 0 = honour the allowlist (default + safe); 1 = skip. Flipped via
  // `foreman agent trust <id>` / `foreman agent untrust <id>`.
  taskSkipPermissions: integer("task_skip_permissions").notNull().default(0),
  // Responsibility-based auto-routing (docs/auto-routing-design.md).
  // `role` buckets the agent into the routing pattern ('coder' |
  // 'reviewer' | 'orchestrator' | 'custom'); NULL = no flow
  // participation, agent behaves as before.
  role: text("role"),
  // JSON array of {when, toRole, template, intent} handoff rules. When
  // this agent finishes a flow step, the router classifies the output
  // and looks up the first rule whose `when` matches; the rule's
  // `toRole` resolves to a peer agent (preferring same role) and the
  // `template` becomes the next step's prompt. NULL = no rules → output
  // flows to orchestrator for summarization.
  handoffRules: text("handoff_rules"),
});

export const policies = sqliteTable(
  "policies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceAgent: text("source_agent").notNull(),
    target: text("target").notNull(),
    effect: text("effect", { enum: ["allow", "deny", "ask"] }).notNull(),
    conditions: text("conditions"),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by", {
      enum: ["user", "remember-action", "yaml"],
    }).notNull(),
    enabled: integer("enabled").notNull().default(1),
  },
  (t) => ({
    lookupIdx: index("policies_lookup_idx").on(
      t.sourceAgent,
      t.target,
      t.enabled,
    ),
  }),
);

export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    sourceAgent: text("source_agent").notNull(),
    targetAgent: text("target_agent"),
    targetTool: text("target_tool"),
    args: text("args").notNull(),
    riskScore: integer("risk_score").notNull(),
    riskReasons: text("risk_reasons"),
    // JSON array of RiskFactor (#224 C1). Nullable for rows written before
    // migration 0007; readers fall back to risk_reasons for those.
    riskFactors: text("risk_factors"),
    riskBucket: text("risk_bucket", {
      enum: ["low", "medium", "high", "critical"],
    }),
    // JSON-encoded LlmVerification populated by the C8 layer; NULL until then.
    llmVerification: text("llm_verification"),
    // JSON-encoded SecurityReport (C9, #232) — 3-layer modal payload kept for
    // compliance + future renderers. NULL for rows before migration 0010.
    securityReport: text("security_report"),
    decision: text("decision", {
      enum: ["allowed", "denied", "pending"],
    }).notNull(),
    decidedBy: text("decided_by"),
    result: text("result"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
    // #301 — agent-to-agent flow tracking. parent_request_id points at the
    // request that triggered this one (e.g. OpenClaw → Hermes delegation);
    // session_id groups every request that descends from a single
    // user-initiated chain so the log can render trees. Both nullable for
    // legacy rows + first-in-chain requests.
    parentRequestId: text("parent_request_id"),
    sessionId: text("session_id"),
  },
  (t) => ({
    sourceCreatedIdx: index("requests_source_created_idx").on(
      t.sourceAgent,
      t.createdAt,
    ),
    decisionCreatedIdx: index("requests_decision_created_idx").on(
      t.decision,
      t.createdAt,
    ),
    sessionIdx: index("requests_session_idx").on(t.sessionId, t.createdAt),
    parentIdx: index("requests_parent_idx").on(t.parentRequestId),
  }),
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  participants: text("participants").notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  messageCount: integer("message_count").notNull().default(0),
  tokenCount: integer("token_count").notNull().default(0),
  status: text("status", { enum: ["active", "completed", "halted"] })
    .notNull()
    .default("active"),
  // #527 — Interactive session resume. When a halt is resolvable (loop
  // detection, eventually turn/token "bump budget"), Foreman asks the
  // user for a resolution + records what was offered + chosen. NULL
  // for halts without an interactive resume path.
  resolutionStatus: text("resolution_status", {
    enum: ["needed", "provided", "consumed", "expired"],
  }),
  /** JSON ResolutionOption[] — what the user saw on the chat buttons.
   *  Persisted so the audit log replays the offer, not just the pick. */
  resolutionOptions: text("resolution_options"),
  /** JSON `{ optionId, payload, providedAt, providedBy }` once resolved.
   *  NULL while still waiting / expired. */
  resolutionPayload: text("resolution_payload"),
  /** Auto-abandon deadline. Mirrors the approval deadline shape. */
  resolutionDeadlineMs: integer("resolution_deadline_ms"),
});

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
});

// #440 — Cross-process control channel for state-mutating /foreman
// verbs. mcp-stdio inserts rows; `foreman start`'s drain loop picks
// them up and dispatches to in-process handlers (daemon shutdown,
// llm.yaml rewrite, etc).
export const controlCommands = sqliteTable(
  "control_commands",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    command: text("command").notNull(),
    args: text("args").notNull(),
    sourceAgent: text("source_agent").notNull(),
    sourceUser: text("source_user"),
    status: text("status", {
      enum: ["pending", "applied", "failed", "rejected"],
    })
      .notNull()
      .default("pending"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    appliedAt: integer("applied_at"),
  },
  (t) => ({
    statusIdx: index("control_commands_status_idx").on(t.status, t.createdAt),
  }),
);

export const secrets = sqliteTable("secrets", {
  name: text("name").primaryKey(),
  valueEncrypted: blob("value_encrypted", { mode: "buffer" }).notNull(),
  iv: blob("iv", { mode: "buffer" }).notNull(),
  authTag: blob("auth_tag", { mode: "buffer" }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastAccessedAt: integer("last_accessed_at"),
});

// Cross-process approval IPC (#117). Foreman's bus is in-memory; a spawned
// `foreman mcp-stdio` or `foreman wrap` process can't reach the TUI's bus
// in `foreman start`. Pending approvals land here; the TUI polls, surfaces
// them in the modal, and writes the decision back.
export const pendingApprovals = sqliteTable(
  "pending_approvals",
  {
    requestId: text("request_id").primaryKey(),
    sourceAgent: text("source_agent").notNull(),
    targetAgent: text("target_agent"),
    targetTool: text("target_tool"),
    args: text("args").notNull(),
    riskScore: integer("risk_score").notNull(),
    riskReasons: text("risk_reasons").notNull(),
    // Carries the rich C1 payload across the cross-process IPC bridge.
    riskFactors: text("risk_factors"),
    riskBucket: text("risk_bucket", {
      enum: ["low", "medium", "high", "critical"],
    }),
    status: text("status", { enum: ["pending", "resolved"] })
      .notNull()
      .default("pending"),
    decision: text("decision", { enum: ["allowed", "denied"] }),
    remember: text("remember", { enum: ["allow", "deny"] }),
    resolvedBy: text("resolved_by", { enum: ["user", "timeout"] }),
    requestedAt: integer("requested_at").notNull(),
    resolvedAt: integer("resolved_at"),
    // #525 — Absolute Unix ms timestamp when the approval auto-resolves to
    // its default decision (typically "deny"). Channels render this as a
    // countdown ("⏱ Auto-deny in 4m 12s"); the bridge re-emits the value
    // on approval:requested so cross-process consumers (the TUI modal,
    // Telegram channel) see the same deadline the writer set.
    // Nullable for legacy rows + callers that don't compute a deadline
    // (BusApprovalService unit tests).
    deadlineMs: integer("deadline_ms"),
  },
  (t) => ({
    statusIdx: index("pending_approvals_status_idx").on(
      t.status,
      t.requestedAt,
    ),
  }),
);

// #528 — Cross-process queue for `ask_user_with_options` MCP calls. The
// tool handler in mcp-stdio inserts a row + polls; the chat listener in
// `foreman start` writes the user's pick back. Same IPC pattern as
// pending_approvals + control_commands.
export const pendingQuestions = sqliteTable(
  "pending_questions",
  {
    id: text("id").primaryKey(),
    sourceAgent: text("source_agent").notNull(),
    sessionId: text("session_id"),
    question: text("question").notNull(),
    context: text("context"),
    optionsJson: text("options_json").notNull(),
    allowFreeText: integer("allow_free_text").notNull().default(1),
    status: text("status", {
      enum: ["pending", "answered", "timeout", "abandoned"],
    })
      .notNull()
      .default("pending"),
    chosenOptionId: text("chosen_option_id"),
    freeText: text("free_text"),
    requestedAt: integer("requested_at").notNull(),
    deadlineMs: integer("deadline_ms").notNull(),
    answeredAt: integer("answered_at"),
    answeredBy: text("answered_by"),
  },
  (t) => ({
    statusIdx: index("pending_questions_status_idx").on(
      t.status,
      t.requestedAt,
    ),
    sessionIdx: index("pending_questions_session_idx").on(t.sessionId),
  }),
);

// Out-of-band notifications (#235 / C11). One row per attempted delivery on
// one channel. `notification_messages` tracks the per-channel message id so
// we can update / cancel later.
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id"),
    level: text("level", {
      enum: [
        "critical",
        "warning",
        "info",
        "summary",
        "budget_alert",
        "risk_deny",
        // #523 — session lifecycle pushes (started / progress / completed).
        // SQLite's notifications.level column is TEXT with no CHECK
        // constraint, so no migration is needed; this enum extension is a
        // TypeScript-only widening that lets the new bridge handlers insert
        // rows without a type assertion.
        "session_lifecycle",
      ],
    }).notNull(),
    channel: text("channel").notNull(),
    body: text("body").notNull(),
    status: text("status", {
      enum: ["sent", "delivered", "failed", "cancelled"],
    })
      .notNull()
      .default("sent"),
    sentAt: integer("sent_at").notNull(),
    deliveredAt: integer("delivered_at"),
    decision: text("decision", {
      enum: ["allow", "deny", "timeout_default"],
    }),
    decidedAt: integer("decided_at"),
    decidedBy: text("decided_by"),
    error: text("error"),
  },
  (t) => ({
    requestIdx: index("notifications_request_idx").on(t.requestId),
    statusIdx: index("notifications_status_idx").on(t.status, t.sentAt),
  }),
);

// LLM call usage log (#230 / C7). One row per provider call so the budget
// tracker can SUM cost_usd over the current billing window. cache_hit lets
// C8/C9 mark cached responses (cost_usd=0) without losing the audit row.
export const llmUsage = sqliteTable(
  "llm_usage",
  {
    id: text("id").primaryKey(),
    ts: integer("ts").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    feature: text("feature").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: real("cost_usd").notNull(),
    requestId: text("request_id"),
    durationMs: integer("duration_ms").notNull(),
    cacheHit: integer("cache_hit").notNull().default(0),
    // #530 — Per-session + per-project cost rollup. session_id matches
    // `sessions.id` (ULID); project_tag is auto-derived from cwd
    // basename when callers don't supply one. Both nullable so legacy
    // rows + ad-hoc / doctor probes stay unaffected; the by-session +
    // by-project queries simply exclude them.
    sessionId: text("session_id"),
    projectTag: text("project_tag"),
  },
  (t) => ({
    tsIdx: index("llm_usage_ts_idx").on(t.ts),
    featureIdx: index("llm_usage_feature_idx").on(t.feature, t.ts),
    sessionIdx: index("llm_usage_session_idx").on(t.sessionId, t.ts),
    projectIdx: index("llm_usage_project_idx").on(t.projectTag, t.ts),
  }),
);

export const notificationMessages = sqliteTable(
  "notification_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    notificationId: text("notification_id").notNull(),
    channel: text("channel").notNull(),
    channelMessageId: text("channel_message_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    channelIdx: index("notification_messages_channel_idx").on(
      t.channel,
      t.channelMessageId,
    ),
  }),
);

// #426 — Primary chat agent per messaging channel. Exactly one agent
// can hold the primary slot per channel; the projector skips messaging-
// channel writes for non-primary agents so two chat-capable agents
// can coexist without polling-collision.
export const chatPrimary = sqliteTable("chat_primary", {
  channel: text("channel").primaryKey(),
  agentId: text("agent_id").notNull(),
  setAt: integer("set_at").notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
export type Request = typeof requests.$inferSelect;
export type NewRequest = typeof requests.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type PendingApproval = typeof pendingApprovals.$inferSelect;
export type NewPendingApproval = typeof pendingApprovals.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationMessage = typeof notificationMessages.$inferSelect;
export type NewNotificationMessage = typeof notificationMessages.$inferInsert;
export type LlmUsage = typeof llmUsage.$inferSelect;
export type NewLlmUsage = typeof llmUsage.$inferInsert;
export type ChatPrimary = typeof chatPrimary.$inferSelect;
export type NewChatPrimary = typeof chatPrimary.$inferInsert;
export type ControlCommand = typeof controlCommands.$inferSelect;
export type NewControlCommand = typeof controlCommands.$inferInsert;
export type PendingQuestion = typeof pendingQuestions.$inferSelect;
export type NewPendingQuestion = typeof pendingQuestions.$inferInsert;

// =============================================================================
// Responsibility-based auto-routing — flows + flow_steps
// =============================================================================
//
// `flows` = one row per user-initiated multi-step goal (e.g. "implement
// to-do-app issues #1-5 and review"). Lifecycle: 'active' → 'completed'
// (success) | 'halted' (cycle ceiling, cost ceiling, manual stop).
//
// `flow_steps` = a directed tree of agent-to-agent handoffs within a
// flow. Root step has source_agent=NULL + parent_step_id=NULL (user
// kicked it off). Each subsequent step references its parent.
// `directive_id` ties the step back to the control_commands row whose
// drain triggered the spawn — gives the full audit trail.

export const flows = sqliteTable(
  "flows",
  {
    id: text("id").primaryKey(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    status: text("status", {
      enum: ["active", "completed", "halted"],
    })
      .notNull()
      .default("active"),
    initiator: text("initiator"),
    goal: text("goal").notNull(),
    currentHolder: text("current_holder"),
    finalSummary: text("final_summary"),
    costUsd: real("cost_usd").notNull().default(0),
    maxSteps: integer("max_steps").notNull().default(10),
    stepCount: integer("step_count").notNull().default(0),
  },
  (t) => ({
    statusIdx: index("idx_flows_status").on(t.status),
    startedAtIdx: index("idx_flows_started_at").on(t.startedAt),
  }),
);

export const flowSteps = sqliteTable(
  "flow_steps",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id),
    parentStepId: text("parent_step_id"),
    stepOrder: integer("step_order").notNull(),
    sourceAgent: text("source_agent"),
    targetAgent: text("target_agent").notNull(),
    directiveId: integer("directive_id").references(() => controlCommands.id),
    intent: text("intent").notNull(),
    prompt: text("prompt").notNull(),
    outputClassification: text("output_classification"),
    outputSummary: text("output_summary"),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => ({
    flowIdx: index("idx_flow_steps_flow").on(t.flowId),
    statusIdx: index("idx_flow_steps_status").on(t.status),
  }),
);

export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;
export type FlowStep = typeof flowSteps.$inferSelect;
export type NewFlowStep = typeof flowSteps.$inferInsert;

// Delegation tracker — autonomous loop enforcement (PR A of the
// multi-agent UX epic). One row per `foreman write <peer> <task>`
// directive. The lifecycle is open → output_received → (closed by
// initiator action | nudged repeatedly | escalated to user).
//
// Watchdog query in start.ts polls rows where status in ('awaiting',
// 'nudged') older than the threshold, pushes a nudge to the
// initiator's chat. See `src/core/delegation-tracker.ts`.
export const delegations = sqliteTable(
  "delegations",
  {
    id: text("id").primaryKey().notNull(),
    initiatorAgent: text("initiator_agent").notNull(),
    targetAgent: text("target_agent").notNull(),
    promptSummary: text("prompt_summary").notNull(),
    controlCommandId: integer("control_command_id"),
    startedAt: integer("started_at").notNull(),
    outputReceivedAt: integer("output_received_at"),
    followUpAt: integer("follow_up_at"),
    nudgeCount: integer("nudge_count").notNull().default(0),
    lastNudgeAt: integer("last_nudge_at"),
    status: text("status", {
      enum: [
        "open",
        "awaiting",
        "nudged",
        "escalated",
        "closed",
        "abandoned",
      ],
    })
      .notNull()
      .default("open"),
    spawnOutcome: text("spawn_outcome"),
  },
  (t) => ({
    statusOutputIdx: index("delegations_status_output_idx").on(
      t.status,
      t.outputReceivedAt,
    ),
    initiatorIdx: index("delegations_initiator_idx").on(t.initiatorAgent),
    targetIdx: index("delegations_target_idx").on(t.targetAgent),
  }),
);

export type Delegation = typeof delegations.$inferSelect;
export type NewDelegation = typeof delegations.$inferInsert;

// FTS5 virtual table and triggers live in a hand-written migration
// (drizzle-kit cannot emit virtual tables). See:
// src/db/migrations/0001_fts5_requests.sql

void sql;
