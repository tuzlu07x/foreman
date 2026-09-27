-- Agent spend ledger (#629).
--
-- One row per unit of model usage by an agent: a model request reported
-- over OpenTelemetry, the usage line a spawned task printed, or Foreman's
-- own LLM calls. Role and department are resolved from org.yaml when the
-- row is written, so reports keep history even if the chart changes.
-- Counts, models and cost only: never prompt or response content.

CREATE TABLE `agent_usage` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `ts` INTEGER NOT NULL,
  `agent_id` TEXT NOT NULL,
  `role` TEXT,
  `department` TEXT,
  -- telemetry | task-output | foreman
  `source` TEXT NOT NULL,
  `model` TEXT,
  `input_tokens` INTEGER NOT NULL DEFAULT 0,
  `output_tokens` INTEGER NOT NULL DEFAULT 0,
  `cache_read_tokens` INTEGER NOT NULL DEFAULT 0,
  `cache_write_tokens` INTEGER NOT NULL DEFAULT 0,
  -- Set when the source only reports a total (e.g. `tokens used: N`).
  `total_tokens` INTEGER NOT NULL DEFAULT 0,
  `cost_usd` REAL NOT NULL DEFAULT 0,
  -- 1 when cost comes from Foreman's price table, not the source.
  `cost_estimated` INTEGER NOT NULL DEFAULT 0,
  -- control_commands id of the task, when known.
  `task_ref` TEXT,
  `session_ref` TEXT
);
--> statement-breakpoint
CREATE INDEX `agent_usage_ts_idx` ON `agent_usage` (`ts`);
--> statement-breakpoint
CREATE INDEX `agent_usage_department_idx` ON `agent_usage` (`department`, `ts`);
--> statement-breakpoint
CREATE INDEX `agent_usage_agent_idx` ON `agent_usage` (`agent_id`, `ts`);
--> statement-breakpoint
CREATE INDEX `agent_usage_task_idx` ON `agent_usage` (`task_ref`);
