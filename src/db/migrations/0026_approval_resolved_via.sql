-- Which surface decided an approval (#637): tui, telegram, slack, discord,
-- webhook or agent_mcp. The requester usually runs in another process
-- (an agent's `foreman mcp-stdio`, the Claude Code hook) and reads the
-- decision from this row, so the channel has to travel with it for the
-- audit log to say `user:tui` rather than just `user`.
ALTER TABLE `pending_approvals` ADD `resolved_via` text;
