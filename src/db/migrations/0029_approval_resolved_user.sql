-- Who decided an approval on Slack or Discord, by the platform's user id
-- (a Slack member id, a Discord user id). Several allowed people can
-- decide there, and the requester reads the decision from this row in
-- another process, so the person has to travel with it for the audit log
-- to say `user:slack:U0BOSS` rather than just `user:slack`. Null for the
-- TUI, Telegram, relayed decisions and rows from before this column.
ALTER TABLE `pending_approvals` ADD `resolved_user` text;
