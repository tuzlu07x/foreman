-- In-app inbox (TUI notification centre, #613).
--
-- One row per thing the user should know about: an approval that was
-- requested or resolved, a call Foreman blocked on its own, a delegation
-- result, a budget alert, a crashed agent daemon, an update. Unlike
-- `notifications` (one row per delivery attempt on an external channel),
-- the inbox works with zero channels configured and keeps read state, so
-- the TUI can show what the user missed while they were away.

CREATE TABLE `inbox_items` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `created_at` INTEGER NOT NULL,
  -- info | warning | critical
  `level` TEXT NOT NULL,
  -- approval | block | delegation | budget | agent | update | system
  `kind` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `body` TEXT NOT NULL DEFAULT '',
  `request_id` TEXT,
  `agent_id` TEXT,
  -- Stable key so the same event reported twice (bus + table poll) lands
  -- once. NULL for events that cannot repeat.
  `dedupe_key` TEXT,
  `read_at` INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_dedupe_idx` ON `inbox_items` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `inbox_items_created_idx` ON `inbox_items` (`created_at`);
--> statement-breakpoint
CREATE INDEX `inbox_items_unread_idx` ON `inbox_items` (`read_at`, `created_at`);
