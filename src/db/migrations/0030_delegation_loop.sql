-- Closing the delegation loop (delegation-loop.ts). Headless agents run
-- once per task, so an agent that hands work off is gone when the result
-- comes back. Foreman now launches it again with the result, and a lead
-- launched for a task sees what it did recently.
--
-- A delegations row is one run of an agent. A fresh hand-off starts a
-- thread (thread_id = its own id); the runs Foreman adds to it later
-- (a wake with results, a nudge) carry the same thread_id. A hand-off made
-- while its sender was running records that run's thread as its
-- parent_thread_id, which is how results find their way back up.
ALTER TABLE `delegations` ADD `thread_id` text;
--> statement-breakpoint
ALTER TABLE `delegations` ADD `parent_thread_id` text;
--> statement-breakpoint
-- What the run produced, for the agent that asked: the end of its output
-- or the friendly failure reason. Secrets redacted, clipped.
ALTER TABLE `delegations` ADD `result_text` text;
--> statement-breakpoint
-- The thread's work is done: its last run ended and everything it handed
-- off is back.
ALTER TABLE `delegations` ADD `settled_at` integer;
--> statement-breakpoint
-- The result went back to the agent that asked (wake_control_id is the
-- control_commands row that re-launched it; null when Foreman gave up and
-- told you instead).
ALTER TABLE `delegations` ADD `woken_at` integer;
--> statement-breakpoint
ALTER TABLE `delegations` ADD `wake_control_id` integer;
--> statement-breakpoint
-- You were told once that this thread is stuck; never again.
ALTER TABLE `delegations` ADD `escalated_at` integer;
--> statement-breakpoint
CREATE INDEX `delegations_thread_idx` ON `delegations` (`thread_id`);
--> statement-breakpoint
CREATE INDEX `delegations_parent_thread_idx` ON `delegations` (`parent_thread_id`);
--> statement-breakpoint
-- Runs Foreman queued itself (control_commands rows from
-- `foreman:delegation`): which thread each continues. thread_id null means
-- the run starts a thread of its own.
CREATE TABLE `delegation_followups` (
  `control_command_id` integer PRIMARY KEY NOT NULL,
  `thread_id` text,
  -- wake  — the agent that asked, with the results
  -- nudge — the agent that owes an answer, reminded
  `kind` text NOT NULL,
  `agent` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delegation_followups_thread_idx` ON `delegation_followups` (`thread_id`, `kind`);
