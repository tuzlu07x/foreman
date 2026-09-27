-- Preserve the channel that resolved a cross-process approval.
ALTER TABLE pending_approvals ADD COLUMN resolved_via TEXT;
