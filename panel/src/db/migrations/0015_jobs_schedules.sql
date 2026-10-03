CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text,
	`name` text NOT NULL,
	`description` text,
	`action` text,
	`target` text,
	`params` text,
	`cron` text,
	`run_at` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`paused_at` integer,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_duration_ms` integer,
	`last_outcome` text,
	`last_error` text,
	`last_result` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_key_unique` ON `schedules` (`key`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `schedule_id` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `summary` text;--> statement-breakpoint
CREATE INDEX `jobs_schedule_idx` ON `jobs` (`schedule_id`);