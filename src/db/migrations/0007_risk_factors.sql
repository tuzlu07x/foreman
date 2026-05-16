-- Adds the factor-model columns (#224 C1). risk_factors holds the JSON array
-- of {rule, points, reason, evidence?, category}; risk_bucket records the
-- low/medium/high/critical band; llm_verification is reserved for the C8
-- LLM-confirmation layer and stays NULL until that lands.
--
-- pending_approvals carries the same columns so the cross-process IPC path
-- (foreman wrap / foreman mcp-stdio → TUI) doesn't lose the rich payload.
--
-- All columns are nullable so rows written before this migration survive
-- with NULL; readers fall back to risk_reasons / risk_score for them.

ALTER TABLE `requests` ADD COLUMN `risk_factors` TEXT;
--> statement-breakpoint
ALTER TABLE `requests` ADD COLUMN `risk_bucket` TEXT;
--> statement-breakpoint
ALTER TABLE `requests` ADD COLUMN `llm_verification` TEXT;
--> statement-breakpoint
ALTER TABLE `pending_approvals` ADD COLUMN `risk_factors` TEXT;
--> statement-breakpoint
ALTER TABLE `pending_approvals` ADD COLUMN `risk_bucket` TEXT;
