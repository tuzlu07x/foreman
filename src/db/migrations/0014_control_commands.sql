-- #440 — Cross-process control channel.
--
-- `foreman mcp-stdio` runs in a separate process from `foreman start`.
-- State-mutating /foreman verbs (stop, llm switch, llm budget, write)
-- need to reach the start process, which owns the daemon manager and
-- the in-memory LlmConfig. This table is the queue: mcp-stdio inserts
-- a row when a verb fires; foreman start polls every ~1.5s, picks up
-- pending rows, dispatches to the matching handler, and updates status.
--
-- Schema notes:
--   - args is JSON (encoded string[]) so handlers can reconstruct
--     positional parameters without per-verb columns.
--   - status enum: pending → applied | failed | rejected. The drain
--     loop never re-runs a row that isn't pending.
--   - source_agent + source_user duplicate the audit-event payload
--     so the queue itself is self-contained; the audit row is the
--     long-term archive (this table is cleared as rows finish).

CREATE TABLE `control_commands` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `command` TEXT NOT NULL,
  `args` TEXT NOT NULL,
  `source_agent` TEXT NOT NULL,
  `source_user` TEXT,
  `status` TEXT NOT NULL DEFAULT 'pending',
  `error` TEXT,
  `created_at` INTEGER NOT NULL,
  `applied_at` INTEGER
);
--> statement-breakpoint
CREATE INDEX `control_commands_status_idx`
  ON `control_commands` (`status`, `created_at`);
