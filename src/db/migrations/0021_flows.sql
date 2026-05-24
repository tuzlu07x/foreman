-- Responsibility-based auto-routing (see docs/auto-routing-design.md).
--
-- Adds three pieces:
--   1. Agent-level role + handoff_rules JSON. responsibility_note already
--      exists (column added pre-#519 as free-form text); we keep it.
--   2. flows: one row per user-initiated multi-step goal. Lifecycle is
--      started → running → completed / halted.
--   3. flow_steps: directed tree of agent-to-agent handoffs within a flow.
--      Each step references the control_commands row it dispatched.
--
-- All new columns nullable / default-safe so existing installs migrate
-- without re-registering agents. Default role = NULL means "no flow
-- participation"; existing one-shot writes keep working unchanged.

ALTER TABLE `agents` ADD COLUMN `role` TEXT;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `handoff_rules` TEXT;
--> statement-breakpoint
CREATE TABLE `flows` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `started_at` INTEGER NOT NULL,
  `ended_at` INTEGER,
  `status` TEXT NOT NULL DEFAULT 'active',
  `initiator` TEXT,
  `goal` TEXT NOT NULL,
  `current_holder` TEXT,
  `final_summary` TEXT,
  `cost_usd` REAL NOT NULL DEFAULT 0,
  `max_steps` INTEGER NOT NULL DEFAULT 10,
  `step_count` INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `idx_flows_status` ON `flows`(`status`);
--> statement-breakpoint
CREATE INDEX `idx_flows_started_at` ON `flows`(`started_at`);
--> statement-breakpoint
CREATE TABLE `flow_steps` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `flow_id` TEXT NOT NULL REFERENCES `flows`(`id`),
  `parent_step_id` TEXT,
  `step_order` INTEGER NOT NULL,
  `source_agent` TEXT,
  `target_agent` TEXT NOT NULL,
  `directive_id` INTEGER REFERENCES `control_commands`(`id`),
  `intent` TEXT NOT NULL,
  `prompt` TEXT NOT NULL,
  `output_classification` TEXT,
  `output_summary` TEXT,
  `status` TEXT NOT NULL DEFAULT 'pending',
  `started_at` INTEGER NOT NULL,
  `completed_at` INTEGER
);
--> statement-breakpoint
CREATE INDEX `idx_flow_steps_flow` ON `flow_steps`(`flow_id`);
--> statement-breakpoint
CREATE INDEX `idx_flow_steps_status` ON `flow_steps`(`status`);
