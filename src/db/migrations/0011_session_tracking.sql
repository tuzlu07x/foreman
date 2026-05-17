-- #301: agent-to-agent flow tracking. Adds two nullable columns to requests
-- plus indexes so `foreman log tail --session <id>` and the upcoming TUI
-- session-tree view stay fast on big logs.
--
-- - parent_request_id: the request that triggered this one (e.g. OpenClaw
--   → Hermes delegation). NULL for first-in-chain calls + legacy rows.
-- - session_id: groups every request that descends from a single user-
--   initiated chain. NULL for legacy rows; the mediator auto-tags new
--   requests when the caller supplies one.

ALTER TABLE `requests` ADD COLUMN `parent_request_id` TEXT;
--> statement-breakpoint
ALTER TABLE `requests` ADD COLUMN `session_id` TEXT;
--> statement-breakpoint
CREATE INDEX `requests_session_idx` ON `requests` (`session_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `requests_parent_idx` ON `requests` (`parent_request_id`);
