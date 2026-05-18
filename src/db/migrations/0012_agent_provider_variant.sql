-- #408 / #412 — Per-agent provider mapping. Stores the variant id Foreman
-- picked for each registered agent so `foreman provider list/switch` knows
-- the current state and `foreman doctor` can validate it against the
-- registry's provider_mapping declarations.
--
-- The existing `agents.llm_provider` column already tracks the Foreman-
-- level provider id (e.g. "openai", "anthropic"). This new column adds
-- the **variant** within that provider — e.g. "via-openrouter" for
-- Hermes/openai, "oauth" for Codex/openai, "native" for OpenClaw/openai.
--
-- NULL means: no variant chosen yet (legacy pre-#408 agent, or the user
-- skipped the provider step). Code paths that read this default back to
-- the registry's `provider_mapping[provider].preferred` value.

ALTER TABLE `agents` ADD COLUMN `provider_variant` TEXT;
