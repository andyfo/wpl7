CREATE TABLE `backup_copies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backup_id` integer NOT NULL,
	`destination_id` integer NOT NULL,
	`status` text NOT NULL,
	`remote_path` text NOT NULL,
	`size_bytes` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `backup_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_copies_backup_dest_idx` ON `backup_copies` (`backup_id`,`destination_id`);--> statement-breakpoint
CREATE INDEX `backup_copies_dest_status_idx` ON `backup_copies` (`destination_id`,`status`);--> statement-breakpoint
CREATE TABLE `backup_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`config` text NOT NULL,
	`secrets` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`copy_types` text NOT NULL,
	`copy_from_ts` integer NOT NULL,
	`retention_scheduled` integer DEFAULT 30 NOT NULL,
	`retention_mode` text DEFAULT 'panel' NOT NULL,
	`bwlimit` text,
	`last_success_at` integer,
	`last_failure_at` integer,
	`last_error` text,
	`last_alert_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_destinations_name_unique` ON `backup_destinations` (`name`);--> statement-breakpoint
ALTER TABLE `backups` ADD `root_path` text;--> statement-breakpoint
ALTER TABLE `backups` ADD `files_present` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `lane` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `backup_root` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `offsite_enabled` integer DEFAULT 1 NOT NULL;