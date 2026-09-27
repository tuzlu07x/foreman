-- Department channels (#630).
--
-- Messages agents (and the owner) send each other through Foreman:
-- department channels, leadership, all-hands, role-to-role threads, and
-- reports to the owner. Stored locally and audited; mirrored to Slack /
-- Discord by `foreman start` when org.yaml maps a channel. Message text is
-- redacted and clipped before it is written.

CREATE TABLE `org_messages` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `ts` INTEGER NOT NULL,
  -- dept:<id> | leadership | all | boss | dm:<a>|<b>
  `channel` TEXT NOT NULL,
  -- agent id, or `boss` for the owner
  `from_agent` TEXT NOT NULL,
  `from_role` TEXT,
  -- message | report | question | handoff | announcement
  `kind` TEXT NOT NULL,
  `text` TEXT NOT NULL,
  `reply_to` TEXT,
  -- set once the mirror worker has posted it (or given up)
  `mirrored_at` INTEGER
);
--> statement-breakpoint
CREATE INDEX `org_messages_channel_idx` ON `org_messages` (`channel`, `ts`);
--> statement-breakpoint
CREATE INDEX `org_messages_ts_idx` ON `org_messages` (`ts`);
--> statement-breakpoint
CREATE INDEX `org_messages_unmirrored_idx` ON `org_messages` (`mirrored_at`, `ts`);
