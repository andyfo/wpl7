CREATE TABLE `app_deploys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`digest` text DEFAULT '' NOT NULL,
	`image_id` text DEFAULT '' NOT NULL,
	`started_at` integer NOT NULL,
	`took_ms` integer,
	`result` text NOT NULL,
	`origin` text NOT NULL,
	`actor` text,
	`job_id` integer,
	`gap_ms` integer,
	`error` text,
	`log_tail` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_deploys_site_idx` ON `app_deploys` (`site_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `app_env` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`secret` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_env_site_name_idx` ON `app_env` (`site_id`,`name`);--> statement-breakpoint
CREATE TABLE `app_mounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`name` text NOT NULL,
	`container_path` text NOT NULL,
	`writable` integer DEFAULT 0 NOT NULL,
	`in_backups` integer DEFAULT 1 NOT NULL,
	`filled_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_mounts_site_name_idx` ON `app_mounts` (`site_id`,`name`);--> statement-breakpoint
CREATE TABLE `app_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`position` integer NOT NULL,
	`host` text NOT NULL,
	`match` text NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`scheme` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_routes_site_idx` ON `app_routes` (`site_id`);--> statement-breakpoint
CREATE INDEX `app_routes_host_idx` ON `app_routes` (`host`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`registry_user` text DEFAULT '' NOT NULL,
	`registry_token` text DEFAULT '' NOT NULL,
	`digest` text DEFAULT '' NOT NULL,
	`image_id` text DEFAULT '' NOT NULL,
	`pending_digest` text DEFAULT '' NOT NULL,
	`port` integer NOT NULL,
	`stop_grace_sec` integer DEFAULT 20 NOT NULL,
	`run_as` text DEFAULT '' NOT NULL,
	`image_uid` integer DEFAULT 0 NOT NULL,
	`image_gid` integer DEFAULT 0 NOT NULL,
	`drop_all_caps` integer DEFAULT 0 NOT NULL,
	`read_only_root` integer DEFAULT 0 NOT NULL,
	`extra_hosts` text DEFAULT '[]' NOT NULL,
	`data_paths` text DEFAULT '[]' NOT NULL,
	`health_path` text DEFAULT '/' NOT NULL,
	`health_host` text DEFAULT '' NOT NULL,
	`deploy_check_path` text DEFAULT '' NOT NULL,
	`health_timeout_sec` integer DEFAULT 60 NOT NULL,
	`update_mode` text DEFAULT 'auto' NOT NULL,
	`check_minutes` integer DEFAULT 15 NOT NULL,
	`checked_at` integer,
	`check_error` text,
	`deploy_token_hash` text,
	`deploy_token_set_at` integer,
	`deploy_wanted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
