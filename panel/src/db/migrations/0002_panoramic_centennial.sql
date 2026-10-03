CREATE TABLE `move_cleanups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`site_slug` text NOT NULL,
	`source_server_id` integer NOT NULL,
	`target_server_id` integer NOT NULL,
	`container_name` text NOT NULL,
	`db_name` text NOT NULL,
	`db_user` text NOT NULL,
	`files_path` text NOT NULL,
	`verify_hosts` text NOT NULL,
	`target_ip` text NOT NULL,
	`proxy_config_path` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer
);
--> statement-breakpoint
CREATE INDEX `move_cleanups_status_idx` ON `move_cleanups` (`status`);