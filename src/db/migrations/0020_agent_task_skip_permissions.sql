-- #517 Faz 3 — `task_skip_permissions` flag on the agents table. Set via
-- `foreman agent trust <id>` when the operator wants to skip the agent's
-- shell-tool allowlist gate (e.g. `claude --dangerously-skip-permissions`)
-- and rely on Foreman's MCP-level mediation as the security boundary
-- instead. NULL/0 = honour the allowlist (default + safe); 1 = skip.
--
-- Per-agent registry entries declare HOW to skip via the new
-- `task_skip_permissions_flag` catalog field (e.g.
-- `--dangerously-skip-permissions` for claude-code). The DB flag flips
-- it on per installation; the catalog flag defines the CLI argument.

ALTER TABLE `agents` ADD COLUMN `task_skip_permissions` INTEGER NOT NULL DEFAULT 0;
