CREATE TABLE `api_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`key_id` integer,
	`key_name` text DEFAULT '' NOT NULL,
	`key_prefix` text DEFAULT '' NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`route` text,
	`status` integer NOT NULL,
	`error_code` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`ip` text,
	`user_agent` text,
	`job_id` integer,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `api_events_ts_idx` ON `api_events` (`ts`);--> statement-breakpoint
CREATE INDEX `api_events_key_idx` ON `api_events` (`key_id`,`ts`);--> statement-breakpoint
CREATE INDEX `api_events_status_idx` ON `api_events` (`status`,`ts`);