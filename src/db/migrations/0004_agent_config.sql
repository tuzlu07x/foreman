-- Per-agent config (#172). llm_provider is the chosen LLM provider id for
-- multi-provider agents (Hermes / OpenClaw / ZeroClaw); single-provider
-- agents leave it NULL. responsibility_note is short free-text the wizard
-- collects ("code review", "daily personal assistant on Telegram") and the
-- audit log + approval modal + dashboard surface back to the user.

ALTER TABLE `agents` ADD COLUMN `llm_provider` TEXT;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `responsibility_note` TEXT;
