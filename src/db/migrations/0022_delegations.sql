-- Delegation tracker (autonomous loop enforcement PR A).
--
-- Foreman watches every `foreman write <peer> <task>` directive and
-- tracks whether the initiating agent acted on the peer's output. When
-- the peer finishes + the initiator stays idle, the watchdog nudges
-- the initiator in chat. Each row is one delegation; the lifecycle is
-- open → output_received → (initiator acts | nudged repeatedly | escalated).
--
-- Why not on `control_commands`: that table is the cross-process command
-- queue (#440); rows there get marked `applied` once the drain handler
-- runs, regardless of whether the initiator did anything with the
-- output afterward. The lifecycle this table tracks is ORTHOGONAL —
-- "did the agent that asked for this work follow up on the result?"
--
-- Why not on `flows` (#519): that table is for explicit multi-step
-- goals declared via `foreman flow start`. Most delegations today are
-- ad-hoc (`foreman write codex …`) and never start a flow. This table
-- captures every delegation, flow or not.

CREATE TABLE `delegations` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `initiator_agent` TEXT NOT NULL,
  `target_agent` TEXT NOT NULL,
  -- Short prompt summary (truncated to 200 chars) so the nudge message
  -- can remind the initiator what they delegated without dumping the
  -- whole task body.
  `prompt_summary` TEXT NOT NULL,
  -- Optional pointer to the control_commands row that carried the
  -- directive. Lets us correlate with the audit trail.
  `control_command_id` INTEGER,
  `started_at` INTEGER NOT NULL,
  -- Set when the peer's spawn outcome was relayed back to chat. Null
  -- while the spawn is in flight. Watchdog only considers rows where
  -- output_received_at is non-null AND follow_up_at is null.
  `output_received_at` INTEGER,
  -- Set when the initiator next took a chat-level action (issued
  -- another `foreman write`, or — future — composed a chat reply
  -- mentioning the task). Closes the lifecycle.
  `follow_up_at` INTEGER,
  -- How many times the watchdog has nudged the initiator. Capped at
  -- max_nudges; after that the delegation escalates to the user.
  `nudge_count` INTEGER NOT NULL DEFAULT 0,
  `last_nudge_at` INTEGER,
  -- open       — spawn in flight, nothing to nudge about
  -- awaiting   — output relayed, waiting for initiator action
  -- nudged     — at least one nudge sent
  -- escalated  — max nudges hit, surfaced to user
  -- closed     — initiator followed up (success path)
  -- abandoned  — manual halt / session reset
  `status` TEXT NOT NULL DEFAULT 'open',
  -- Outcome of the spawn (ok | failed | timeout | spawn-error). Stored
  -- so the nudge text can say "codex failed (exit 1) — handle this"
  -- instead of generic "codex finished".
  `spawn_outcome` TEXT
);
--> statement-breakpoint
-- Watchdog query: rows in 'awaiting' or 'nudged' state ordered by
-- output_received_at. Index makes the periodic check (~every 15s)
-- O(log n) regardless of completed-delegation history size.
CREATE INDEX `delegations_status_output_idx`
  ON `delegations` (`status`, `output_received_at`);
--> statement-breakpoint
-- Lookups by initiator (TUI panel + CLI list) + by target (audit).
CREATE INDEX `delegations_initiator_idx` ON `delegations` (`initiator_agent`);
--> statement-breakpoint
CREATE INDEX `delegations_target_idx` ON `delegations` (`target_agent`);
