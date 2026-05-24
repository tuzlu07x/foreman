-- #525: surface the approval deadline so Telegram (and other channels) can
-- render a live countdown — "⏱ Auto-deny in 4m 12s". The backend timeout
-- already exists (DbApprovalService computes it from timeoutMs); this
-- column persists the absolute deadline timestamp so the bridge re-emitting
-- approval:requested events to the TUI process carries the same value
-- without having to know the service's configured timeoutMs.
--
-- Nullable for legacy rows + for callers (BusApprovalService in unit tests)
-- that don't compute a deadline. Channels skip the countdown line when
-- deadline_ms is NULL — backward-compatible everywhere.

ALTER TABLE `pending_approvals` ADD COLUMN `deadline_ms` INTEGER;
