-- Cross-process approval IPC (#117). The bus-based BusApprovalService only
-- works inside one Node process; spawned `foreman mcp-stdio` and `foreman
-- wrap` processes can't reach the TUI's approval modal that way. This
-- table is the bridge: requesting services INSERT a 'pending' row and poll
-- for resolution; the TUI in `foreman start` polls for pending rows,
-- surfaces them in the modal, and writes the decision back.

CREATE TABLE `pending_approvals` (
  `request_id`    TEXT PRIMARY KEY NOT NULL,
  `source_agent`  TEXT NOT NULL,
  `target_agent`  TEXT,
  `target_tool`   TEXT,
  `args`          TEXT NOT NULL,
  `risk_score`    INTEGER NOT NULL,
  `risk_reasons`  TEXT NOT NULL,
  `status`        TEXT NOT NULL DEFAULT 'pending',
  `decision`      TEXT,
  `remember`      TEXT,
  `resolved_by`   TEXT,
  `requested_at`  INTEGER NOT NULL,
  `resolved_at`   INTEGER
);
--> statement-breakpoint
CREATE INDEX `pending_approvals_status_idx`
  ON `pending_approvals` (`status`, `requested_at`);
