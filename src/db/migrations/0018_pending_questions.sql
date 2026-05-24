-- #528: `ask_user_with_options` MCP tool. Agents call the tool to surface
-- a structured product decision to the user ("shadcn/ui or custom?"),
-- Foreman dispatches the question to the user's chat channel with
-- option buttons, and the agent's blocking tool call resolves when the
-- user picks (or the timeout fires).
--
-- Cross-process IPC: the tool handler lives in mcp-stdio, the chat
-- listener that resolves the answer lives in `foreman start`. SQLite
-- is the shared queue — same pattern the approval flow uses.
--
-- Status lifecycle:
--   'pending'   → freshly created, waiting on the user
--   'answered'  → user picked an option or typed free text
--   'timeout'   → deadline elapsed, no answer
--   'abandoned' → user dismissed (/cancel verb)

CREATE TABLE `pending_questions` (
  `id`               TEXT PRIMARY KEY NOT NULL,
  `source_agent`     TEXT NOT NULL,
  `session_id`       TEXT,
  `question`         TEXT NOT NULL,
  `context`          TEXT,
  `options_json`     TEXT NOT NULL,
  `allow_free_text`  INTEGER NOT NULL DEFAULT 1,
  `status`           TEXT NOT NULL DEFAULT 'pending',
  `chosen_option_id` TEXT,
  `free_text`        TEXT,
  `requested_at`     INTEGER NOT NULL,
  `deadline_ms`      INTEGER NOT NULL,
  `answered_at`      INTEGER,
  `answered_by`      TEXT
);
--> statement-breakpoint
CREATE INDEX `pending_questions_status_idx`
  ON `pending_questions` (`status`, `requested_at`);
--> statement-breakpoint
CREATE INDEX `pending_questions_session_idx`
  ON `pending_questions` (`session_id`);
