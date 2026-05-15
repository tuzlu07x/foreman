-- Disabled lifecycle state for agents (#157). "disabled" means the user
-- temporarily paused the agent — config + MCP wiring are preserved, but the
-- mediator + auth path reject incoming requests until the user re-enables.
-- SQLite's TEXT columns don't enforce enums at the DB level (drizzle does it
-- in the app layer), so no schema rewrite is required; this migration is a
-- bookkeeping marker so the journal advances alongside the enum extension.

SELECT 1;
