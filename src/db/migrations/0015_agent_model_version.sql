-- #434 — Per-agent specific model version.
--
-- llmProvider + providerVariant (#408 / #412) tell the projector WHICH
-- variant of the provider mapping to use for a given agent. The model
-- ID inside that variant is hardcoded in registry/agents.json (e.g.
-- claude-haiku-4-5-20251001). This column lets the user override
-- that default per agent — Hermes on claude-opus-4-7, OpenClaw on
-- claude-haiku-4-5 — without forking the registry.
--
-- NULL means "use the variant's default model" (legacy behavior). The
-- wizard's new model-pick step writes a value here when the user
-- explicitly chooses; `foreman provider model <agent> <id>` rotates it.

ALTER TABLE `agents` ADD COLUMN `model_version` TEXT;
