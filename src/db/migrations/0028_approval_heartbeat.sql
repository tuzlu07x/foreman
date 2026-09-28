-- When the requester last showed it is still waiting (#691). The process
-- that opened an approval (an agent's `foreman mcp-stdio`, the Claude Code
-- hook, the daemon) refreshes it every few seconds while it waits. A row
-- whose requester stopped refreshing (killed, crashed, closed terminal) is
-- resolved as cancelled by the approval bridge instead of being offered as
-- a decision that can no longer run.
ALTER TABLE `pending_approvals` ADD `heartbeat_ms` integer;
