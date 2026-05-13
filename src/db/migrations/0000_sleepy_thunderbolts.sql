CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`public_key` blob NOT NULL,
	`transport` text NOT NULL,
	`endpoint` text,
	`registered_at` integer NOT NULL,
	`last_seen_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_agent` text NOT NULL,
	`target` text NOT NULL,
	`effect` text NOT NULL,
	`conditions` text,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`source_agent` text NOT NULL,
	`target_agent` text,
	`target_tool` text,
	`args` text NOT NULL,
	`risk_score` integer NOT NULL,
	`risk_reasons` text,
	`decision` text NOT NULL,
	`decided_by` text,
	`result` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`participants` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`token_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `policies_lookup_idx` ON `policies` (`source_agent`,`target`,`enabled`);--> statement-breakpoint
CREATE INDEX `requests_source_created_idx` ON `requests` (`source_agent`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_decision_created_idx` ON `requests` (`decision`,`created_at`);