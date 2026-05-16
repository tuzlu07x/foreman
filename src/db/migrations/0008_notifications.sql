-- C11a (#235): out-of-band notification channels. Each `notifications` row
-- represents one alert delivered (or attempted) on one channel; the
-- `notification_messages` table tracks the channel-side message id so we can
-- update / cancel the message later (e.g. "decision resolved" follow-ups).
--
-- Decision is stored here so the audit trail is complete even when the user
-- never opens the TUI — the channel callback writes the decision directly.

CREATE TABLE `notifications` (
  `id`            TEXT PRIMARY KEY NOT NULL,
  `request_id`    TEXT,
  `level`         TEXT NOT NULL,
  `channel`       TEXT NOT NULL,
  `body`          TEXT NOT NULL,
  `status`        TEXT NOT NULL DEFAULT 'sent',
  `sent_at`       INTEGER NOT NULL,
  `delivered_at`  INTEGER,
  `decision`      TEXT,
  `decided_at`    INTEGER,
  `decided_by`    TEXT,
  `error`         TEXT
);
--> statement-breakpoint
CREATE INDEX `notifications_request_idx`
  ON `notifications` (`request_id`);
--> statement-breakpoint
CREATE INDEX `notifications_status_idx`
  ON `notifications` (`status`, `sent_at`);
--> statement-breakpoint
CREATE TABLE `notification_messages` (
  `id`                  INTEGER PRIMARY KEY AUTOINCREMENT,
  `notification_id`     TEXT NOT NULL,
  `channel`             TEXT NOT NULL,
  `channel_message_id`  TEXT NOT NULL,
  `created_at`          INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_messages_channel_idx`
  ON `notification_messages` (`channel`, `channel_message_id`);
