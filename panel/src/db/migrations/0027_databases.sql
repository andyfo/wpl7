CREATE TABLE `server_database_scans` (
	`server_id` integer PRIMARY KEY NOT NULL,
	`scanned_at` integer,
	`attempted_at` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `server_databases` (
	`server_id` integer NOT NULL,
	`name` text NOT NULL,
	`tables` integer NOT NULL,
	`bytes` integer NOT NULL,
	`collation` text,
	PRIMARY KEY(`server_id`, `name`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_databases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_databases_name_unique` ON `site_databases` (`name`);--> statement-breakpoint
CREATE INDEX `site_databases_site_idx` ON `site_databases` (`site_id`);--> statement-breakpoint
ALTER TABLE `move_cleanups` ADD `extra_dbs` text;