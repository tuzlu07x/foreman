-- C9 (#232): persist the SecurityReport (3-layer modal payload) on the audit
-- row so `foreman log show <id>` and future compliance exports can reproduce
-- the exact narrative the user saw at decision time. Nullable for rows
-- written before this migration.

ALTER TABLE `requests` ADD COLUMN `security_report` TEXT;
