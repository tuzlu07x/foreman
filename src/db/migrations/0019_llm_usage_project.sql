-- #530: per-project + per-session cost rollup. The current llm_usage
-- table is per-window aggregate-only ("how much have I spent this
-- month?"). Bölüm 8 of the Pazartesi sabahı scenario asks for the
-- per-project line item ("todo-app projesi tamamlandı, toplam maliyet:
-- $1.18") — and #523's session:completed event ships costUsd: 0 as a
-- placeholder until this column exists.
--
-- Both columns are nullable. NULL = "didn't tag at the time" — legacy
-- rows + ad-hoc calls (cwd outside a project, doctor probes) still
-- record fine; the by-session / by-project queries just don't see them.
-- session_id matches `sessions.id` shape (ULID); project_tag is a
-- user-supplied label, currently auto-derived from cwd basename.

ALTER TABLE `llm_usage` ADD COLUMN `session_id` TEXT;
--> statement-breakpoint
ALTER TABLE `llm_usage` ADD COLUMN `project_tag` TEXT;
--> statement-breakpoint
CREATE INDEX `llm_usage_session_idx`
  ON `llm_usage` (`session_id`, `ts`);
--> statement-breakpoint
CREATE INDEX `llm_usage_project_idx`
  ON `llm_usage` (`project_tag`, `ts`);
