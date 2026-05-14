import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
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
  status: text("status", { enum: ["active", "inactive", "blocked"] })
    .notNull()
    .default("active"),
  metadata: text("metadata"),
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
    decision: text("decision", {
      enum: ["allowed", "denied", "pending"],
    }).notNull(),
    decidedBy: text("decided_by"),
    result: text("result"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
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
});

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
});

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
    status: text("status", { enum: ["pending", "resolved"] })
      .notNull()
      .default("pending"),
    decision: text("decision", { enum: ["allowed", "denied"] }),
    remember: text("remember", { enum: ["allow", "deny"] }),
    resolvedBy: text("resolved_by", { enum: ["user", "timeout"] }),
    requestedAt: integer("requested_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => ({
    statusIdx: index("pending_approvals_status_idx").on(
      t.status,
      t.requestedAt,
    ),
  }),
);

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

// FTS5 virtual table and triggers live in a hand-written migration
// (drizzle-kit cannot emit virtual tables). See:
// src/db/migrations/0001_fts5_requests.sql

void sql;
