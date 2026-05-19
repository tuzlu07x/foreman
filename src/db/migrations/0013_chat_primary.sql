-- #426 — Primary chat agent per messaging channel.
--
-- Multiple chat-capable agents (Hermes + OpenClaw + ZeroClaw + future)
-- can be registered at once, but Telegram (and Discord/Slack) accept
-- only one bot consumer at a time. This table designates which agent
-- is the "primary" chat consumer for each channel. The projection
-- step writes that channel's secret only to the primary; the rest
-- run headless.
--
-- Primary key on `channel` because each channel can have at most one
-- primary agent. agent_id stores the foreman registry id (e.g.
-- "hermes", "openclaw") — not enforced as FK so deletion of an agent
-- leaves a dangling row; the service treats unknown agent_ids as
-- "no primary configured" and the CLI surfaces that to the operator.

CREATE TABLE `chat_primary` (
  `channel` TEXT PRIMARY KEY,
  `agent_id` TEXT NOT NULL,
  `set_at` INTEGER NOT NULL
);
