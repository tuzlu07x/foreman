-- #527: interactive session resume after halt. When the loop detector
-- (or other recoverable halt reason) fires, Foreman now asks the user
-- "what do you want to do?" with a short option set ("skip / delegate
-- to PM / I'll decide / abandon") in their channel. The chosen option
-- is delivered back to the agents as a follow-up write directive so
-- the session can continue without a manual restart.
--
-- Four new columns on `sessions`, all nullable so legacy + non-
-- resolvable halts stay backward-compatible. The base `status` enum
-- (active / halted / completed) stays as-is — `resolution_status` is
-- a sub-state of `halted`:
--
--   resolution_status = 'needed'    → user-resolution-needed
--                       'provided'  → user picked, resume in progress
--                       'consumed'  → resume completed, write enqueued
--                       'expired'   → timeout window elapsed, abandoned
--                       NULL        → not a resumable halt (manual halts,
--                                     turn/token limits without bump path)
--
-- resolution_options:  JSON ResolutionOption[] the user saw on the chat
--                      buttons. Persisted so the audit log can replay
--                      what was offered, not just what was picked.
-- resolution_payload:  JSON object — { optionId, payload, providedAt,
--                      providedBy } once the user resolves. NULL until
--                      then.
-- resolution_deadline_ms: when the resolution-needed prompt expires +
--                        the session auto-abandons. Mirrors the approval
--                        deadline shape (#525).

ALTER TABLE `sessions` ADD COLUMN `resolution_status` TEXT;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `resolution_options` TEXT;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `resolution_payload` TEXT;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `resolution_deadline_ms` INTEGER;
