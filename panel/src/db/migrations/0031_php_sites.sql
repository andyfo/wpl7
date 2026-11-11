CREATE TABLE `site_cron` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`expr` text NOT NULL,
	`command` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`timeout_min` integer DEFAULT 5 NOT NULL,
	`next_run_at` integer,
	`last_started_at` integer,
	`last_ms` integer,
	`last_exit` integer,
	`last_output` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_cron_site_idx` ON `site_cron` (`site_id`);--> statement-breakpoint
ALTER TABLE `backups` ADD `has_database` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `app` text DEFAULT 'wordpress' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `web_root` text DEFAULT '' NOT NULL;